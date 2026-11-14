import prisma from "../db.server";
import { getSettings } from "./settings.server";
import { ensureMember, isExcludedByTags } from "./members.server";
import {
  creditPoints,
  debitPoints,
  releasePending,
  restoreDebit,
  shrinkPending,
  withMemberLock,
} from "./ledger.server";
import { addDays, computeReleaseAt, eligibleAmountFromOrder, purchasePoints, refundReversal, roundMoney, streakDue } from "./math";
import { fetchOrderShipping } from "./shopify-api.server";
import { qualifyReferralOnFulfilment, linkReferralFromCheckout } from "./referrals.server";
import { runEffects } from "./effects.server";

const TESTER_TAG = "club-tester";

function tagsOf(customer) {
  return String(customer?.tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Is the program earning for this customer? Before launch only `club-tester` customers earn. */
export function programActiveFor(settings, tags) {
  if (settings.isLive) return true;
  return tags.some((t) => t.toLowerCase() === TESTER_TAG);
}

/** orders/paid: record pending purchase points and mark loyalty codes as used. */
export async function handleOrderPaid(shop, order, admin) {
  const settings = await getSettings(shop);
  const orderId = String(order.id);
  const codes = (order.discount_codes || []).map((d) => String(d.code || "").toUpperCase()).filter(Boolean);

  if (codes.length) {
    await prisma.redemption.updateMany({
      where: { shop, code: { in: codes }, status: "ISSUED" },
      data: { status: "USED", usedOrderId: orderId, usedAt: new Date() },
    });
  }

  const customer = order.customer;
  if (!customer?.id) return { skipped: "no_customer" };
  const tags = tagsOf(customer);
  if (!programActiveFor(settings, tags)) return { skipped: "not_live" };
  if (isExcludedByTags(settings, tags)) return { skipped: "excluded_tag" };

  const member = await ensureMember(shop, customer.id, {
    email: customer.email || order.email,
    firstName: customer.first_name,
    lastName: customer.last_name,
  });

  const effects = [];
  const refCode = (order.note_attributes || []).find((a) => a.name === "_club_ref")?.value;
  if (refCode) {
    await linkReferralFromCheckout(shop, member, refCode, settings, effects).catch((err) =>
      console.error("[club] referral from checkout failed:", err.message),
    );
  }

  const paidAt = new Date(order.processed_at || order.created_at || Date.now());
  const eligible = eligibleAmountFromOrder(order);
  const orderTotal = roundMoney(order.current_total_price ?? order.total_price ?? 0);

  const result = await withMemberLock(member.id, async (tx, locked) => {
    const existing = await tx.loyaltyOrder.findUnique({ where: { shop_orderId: { shop, orderId } } });
    if (existing) return { duplicate: true };

    const tier = locked.tierId ? await tx.tier.findUnique({ where: { id: locked.tierId } }) : null;
    const multiplier = tier?.multiplier || 1;
    const points = settings.earnRules.purchase.enabled && !locked.excluded
      ? purchasePoints(eligible, settings.pointsPerCurrency, multiplier)
      : 0;

    const loyaltyOrder = await tx.loyaltyOrder.create({
      data: {
        shop,
        orderId,
        orderName: order.name || null,
        memberId: locked.id,
        eligibleAmount: eligible,
        multiplier,
        points,
        status: points > 0 ? "PENDING" : "CANCELLED",
        paidAt,
        usedCodes: codes,
        releaseAt: points > 0 ? computeReleaseAt(settings, { paidAt }) : null,
      },
    });

    if (points > 0) {
      await creditPoints(
        tx,
        locked,
        settings,
        {
          points,
          type: "PURCHASE",
          status: "PENDING",
          key: `order:${orderId}`,
          orderId,
          description: `Order ${order.name || `#${orderId}`}`,
          meta: { eligible, multiplier },
        },
        effects,
      );
    }

    await tx.member.update({
      where: { id: locked.id },
      data: {
        ordersCount: { increment: 1 },
        totalSpent: { increment: orderTotal },
        lastOrderAt: paidAt,
      },
    });
    return { loyaltyOrder, points };
  });

  await runEffects(shop, effects, admin);
  return result;
}

/** fulfillments/create + fulfillments/update: track shipping to schedule the unlock. */
export async function handleFulfillment(shop, fulfillment, admin) {
  const orderId = String(fulfillment.order_id || "");
  if (!orderId) return { skipped: "no_order" };
  const lo = await prisma.loyaltyOrder.findUnique({ where: { shop_orderId: { shop, orderId } } });
  if (!lo) return { skipped: "unknown_order" };
  const settings = await getSettings(shop);

  let fulfilledAt = lo.fulfilledAt;
  let deliveredAt = lo.deliveredAt;
  if (fulfillment.status === "success") {
    const at = new Date(fulfillment.created_at || Date.now());
    if (!fulfilledAt || at < fulfilledAt) fulfilledAt = at;
  }

  // Ask Shopify for the whole order: an order with several parcels counts as
  // delivered only when every parcel is.
  if (admin) {
    const shipping = await fetchOrderShipping(admin, orderId).catch(() => null);
    if (shipping) {
      fulfilledAt = shipping.fulfilledAt || fulfilledAt;
      deliveredAt = shipping.deliveredAt || deliveredAt;
    }
  } else if (fulfillment.shipment_status === "delivered") {
    deliveredAt = new Date(fulfillment.updated_at || Date.now());
  }

  const releaseAt = lo.status === "PENDING" ? computeReleaseAt(settings, { paidAt: lo.paidAt, fulfilledAt, deliveredAt }) : lo.releaseAt;
  await prisma.loyaltyOrder.update({
    where: { id: lo.id },
    data: { fulfilledAt, deliveredAt, releaseAt, checkedAt: new Date() },
  });

  const effects = [];
  if (fulfilledAt) {
    await qualifyReferralOnFulfilment(shop, lo.memberId, orderId, settings, effects);
  }
  await runEffects(shop, effects, admin);
  return { fulfilledAt, deliveredAt, releaseAt };
}

/** orders/cancelled: drop pending points, claw back released ones, optionally refund points spent. */
export async function handleOrderCancelled(shop, order, admin) {
  const orderId = String(order.id);
  const settings = await getSettings(shop);
  const effects = [];
  const lo = await prisma.loyaltyOrder.findUnique({ where: { shop_orderId: { shop, orderId } } });

  if (lo && lo.status !== "CANCELLED") {
    await withMemberLock(lo.memberId, async (tx, member) => {
      const entry = await tx.ledgerEntry.findUnique({
        where: { shop_idempotencyKey: { shop, idempotencyKey: `order:${orderId}` } },
      });
      const outstanding = lo.points - lo.pointsReversed;
      if (entry?.status === "PENDING") {
        await shrinkPending(tx, member, entry, entry.points, effects);
      } else if (outstanding > 0) {
        await debitPoints(
          tx,
          member,
          {
            points: outstanding,
            type: "REFUND_REVERSAL",
            key: `cancel:${orderId}`,
            orderId,
            description: `Order ${lo.orderName || `#${orderId}`} cancelled`,
            allowPartial: true,
          },
          effects,
        );
        await tx.member.update({ where: { id: member.id }, data: { lifetimeEarned: { decrement: Math.min(outstanding, member.lifetimeEarned) } } });
      }
      await tx.loyaltyOrder.update({
        where: { id: lo.id },
        data: { status: "CANCELLED", pointsReversed: lo.points, releaseAt: null },
      });
    });
  }

  if (settings.restorePointsOnCancel) {
    const used = await prisma.redemption.findMany({ where: { shop, usedOrderId: orderId, status: "USED" } });
    for (const redemption of used) {
      await withMemberLock(redemption.memberId, async (tx, member) => {
        const debit = await tx.ledgerEntry.findUnique({
          where: { shop_idempotencyKey: { shop, idempotencyKey: `redeem:${redemption.id}` } },
        });
        if (debit) {
          await restoreDebit(
            tx,
            member,
            debit,
            { key: `restore:${redemption.id}`, description: `Points returned: order ${order.name || orderId} cancelled` },
            effects,
          );
        }
        await tx.redemption.update({ where: { id: redemption.id }, data: { status: "CANCELLED" } });
      });
    }
  }

  await runEffects(shop, effects, admin);
}

function refundedEligibleAmount(refund) {
  return roundMoney(
    (refund.refund_line_items || []).reduce((sum, item) => {
      if (item.line_item?.gift_card) return sum;
      return sum + Number(item.subtotal || 0);
    }, 0),
  );
}

/** refunds/create: take back points in proportion to the refunded amount. */
export async function handleRefund(shop, refund, admin) {
  const orderId = String(refund.order_id || "");
  const refundId = String(refund.id || "");
  if (!orderId || !refundId) return { skipped: "bad_payload" };
  const lo = await prisma.loyaltyOrder.findUnique({ where: { shop_orderId: { shop, orderId } } });
  if (!lo || lo.status === "CANCELLED") return { skipped: "no_points" };
  if (lo.refundIds.includes(refundId)) return { duplicate: true };

  const amount = refundedEligibleAmount(refund);
  const effects = [];
  const result = await withMemberLock(lo.memberId, async (tx, member) => {
    const fresh = await tx.loyaltyOrder.findUniqueOrThrow({ where: { id: lo.id } });
    if (fresh.refundIds.includes(refundId)) return { duplicate: true };
    const refundedTotal = roundMoney(fresh.refundedAmount + amount);
    const delta = refundReversal({
      orderPoints: fresh.points,
      eligibleAmount: fresh.eligibleAmount,
      refundedTotal,
      alreadyReversed: fresh.pointsReversed,
    });

    if (delta > 0) {
      const entry = await tx.ledgerEntry.findUnique({
        where: { shop_idempotencyKey: { shop, idempotencyKey: `order:${orderId}` } },
      });
      if (entry?.status === "PENDING") {
        await shrinkPending(tx, member, entry, delta, effects);
      } else {
        await debitPoints(
          tx,
          member,
          {
            points: delta,
            type: "REFUND_REVERSAL",
            key: `refund:${refundId}`,
            orderId,
            description: `Refund on order ${fresh.orderName || `#${orderId}`}`,
            allowPartial: true,
          },
          effects,
        );
        await tx.member.update({ where: { id: member.id }, data: { lifetimeEarned: { decrement: Math.min(delta, member.lifetimeEarned) } } });
      }
    }

    const fullyRefunded = fresh.pointsReversed + delta >= fresh.points;
    await tx.loyaltyOrder.update({
      where: { id: fresh.id },
      data: {
        refundedAmount: refundedTotal,
        pointsReversed: { increment: delta },
        refundIds: { push: refundId },
        status: fullyRefunded && fresh.status === "PENDING" ? "CANCELLED" : fresh.status,
        releaseAt: fullyRefunded && fresh.status === "PENDING" ? null : fresh.releaseAt,
      },
    });
    return { reversed: delta };
  });
  await runEffects(shop, effects, admin);
  return result;
}

/**
 * Order-streak bonus: every Nth credited order paid inside the streak window
 * earns a flat coin bonus. Idempotent per order.
 */
async function awardStreak(tx, member, settings, order, now, effects) {
  const rule = settings.earnRules.streak;
  if (!rule?.enabled || !rule.points || member.excluded) return;
  const count = await tx.loyaltyOrder.count({
    where: { memberId: member.id, status: "CREDITED", paidAt: { gte: addDays(now, -rule.windowDays) } },
  });
  if (!streakDue(count, rule.orders)) return;
  await creditPoints(
    tx,
    member,
    settings,
    {
      points: rule.points,
      type: "STREAK",
      key: `streak:${order.orderId}`,
      orderId: order.orderId,
      description: `${rule.orders}-order streak bonus`,
    },
    effects,
  );
}

/** Cron: unlock purchase coins whose release date has passed. */
export async function releaseDueOrders(shop, now = new Date()) {
  const settings = await getSettings(shop);
  const due = await prisma.loyaltyOrder.findMany({
    where: { shop, status: "PENDING", releaseAt: { lte: now } },
    take: 500,
    orderBy: { releaseAt: "asc" },
  });
  const effects = [];
  let released = 0;
  for (const lo of due) {
    await withMemberLock(lo.memberId, async (tx, member) => {
      const fresh = await tx.loyaltyOrder.findUniqueOrThrow({ where: { id: lo.id } });
      if (fresh.status !== "PENDING") return;
      const entry = await tx.ledgerEntry.findUnique({
        where: { shop_idempotencyKey: { shop, idempotencyKey: `order:${fresh.orderId}` } },
      });
      // Mark the order credited first so it counts toward the member's tier spend.
      await tx.loyaltyOrder.update({ where: { id: fresh.id }, data: { status: "CREDITED" } });
      if (entry) {
        const r = await releasePending(tx, member, settings, entry, effects);
        released += r.released;
      }
      await awardStreak(tx, member, settings, fresh, now, effects);
    });
  }
  await runEffects(shop, effects);
  return { orders: due.length, points: released };
}

/**
 * Cron: some couriers never send a delivery webhook. Poll Shopify for pending
 * orders we have not checked for a while and refresh their release date.
 */
export async function pollPendingShipping(shop, admin, now = new Date()) {
  const settings = await getSettings(shop);
  if (settings.creditTrigger === "PAID") return { checked: 0 };
  const stale = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const orders = await prisma.loyaltyOrder.findMany({
    where: {
      shop,
      status: "PENDING",
      deliveredAt: null,
      paidAt: { lte: new Date(now.getTime() - 12 * 60 * 60 * 1000) },
      OR: [{ checkedAt: null }, { checkedAt: { lte: stale } }],
    },
    take: 100,
    orderBy: { checkedAt: { sort: "asc", nulls: "first" } },
  });
  let checked = 0;
  for (const lo of orders) {
    const shipping = await fetchOrderShipping(admin, lo.orderId).catch((err) => {
      console.error(`[club] shipping poll failed for ${lo.orderId}:`, err.message);
      return null;
    });
    checked++;
    if (!shipping) {
      await prisma.loyaltyOrder.update({ where: { id: lo.id }, data: { checkedAt: now } });
      continue;
    }
    if (shipping.cancelledAt) {
      await handleOrderCancelled(shop, { id: lo.orderId, name: lo.orderName }, admin);
      continue;
    }
    const fulfilledAt = shipping.fulfilledAt || lo.fulfilledAt;
    const deliveredAt = shipping.deliveredAt || lo.deliveredAt;
    await prisma.loyaltyOrder.update({
      where: { id: lo.id },
      data: {
        fulfilledAt,
        deliveredAt,
        checkedAt: now,
        releaseAt: computeReleaseAt(settings, { paidAt: lo.paidAt, fulfilledAt, deliveredAt }),
      },
    });
    if (fulfilledAt && !lo.fulfilledAt) {
      const effects = [];
      await qualifyReferralOnFulfilment(shop, lo.memberId, lo.orderId, settings, effects);
      await runEffects(shop, effects, admin);
    }
  }
  return { checked };
}
