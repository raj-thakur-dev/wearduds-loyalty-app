import prisma from "../db.server";
import { getSettings } from "./settings.server";
import { debitPoints, restoreDebit, withMemberLock, LoyaltyError } from "./ledger.server";
import { addDays, formatMoney, minimumSubtotalFor, pointsToMoney, randomCode, rankOf } from "./math";
import { createRewardDiscount, creditStoreCredit } from "./shopify-api.server";
import { runEffects } from "./effects.server";

const MAX_OPEN_CODES = 5;
const MAX_PER_HOUR = 6;

function rewardLabel(type, value, currency) {
  if (type === "PERCENTAGE") return `${value}% off`;
  if (type === "FREE_SHIPPING") return "Free shipping";
  return `${formatMoney(value, currency)} off`;
}

async function guardRate(memberId) {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [recent, open] = await Promise.all([
    prisma.redemption.count({ where: { memberId, createdAt: { gte: hourAgo } } }),
    prisma.redemption.count({ where: { memberId, status: "ISSUED", kind: "DISCOUNT_CODE" } }),
  ]);
  if (recent >= MAX_PER_HOUR) {
    throw new LoyaltyError("RATE_LIMITED", "That's a lot of rewards in an hour. Try again in a bit.", 429);
  }
  if (open >= MAX_OPEN_CODES) {
    throw new LoyaltyError("TOO_MANY_CODES", `You already have ${open} unused codes. Use one before unlocking another.`);
  }
}

/**
 * Resolves what a redemption request is worth. Either a catalogue reward
 * (`rewardId`) or a free amount of points from the cart slider (`points`).
 */
async function resolveOffer(shop, settings, member, { rewardId, points }) {
  if (rewardId) {
    const reward = await prisma.reward.findFirst({ where: { id: String(rewardId), shop, active: true } });
    if (!reward) throw new LoyaltyError("NO_REWARD", "That reward isn't available any more.");
    if (reward.minTierId) {
      const tiers = await prisma.tier.findMany({ where: { shop }, orderBy: { threshold: "asc" } });
      const needed = tiers.find((t) => t.id === reward.minTierId);
      const mine = tiers.find((t) => t.id === member.tierId);
      if (needed && rankOf(tiers, mine) < rankOf(tiers, needed)) {
        throw new LoyaltyError("TIER_LOCKED", `This reward unlocks at ${needed.name}.`);
      }
    }
    const amount = reward.type === "FIXED_AMOUNT" ? reward.value : 0;
    return {
      reward,
      points: reward.pointsCost,
      rewardType: reward.type,
      value: reward.value,
      label: rewardLabel(reward.type, reward.value, settings.currencyCode),
      minSubtotal:
        reward.type === "FIXED_AMOUNT"
          ? minimumSubtotalFor(amount, settings.maxRedeemPercent, reward.minSubtotal)
          : reward.minSubtotal || null,
    };
  }

  if (!settings.sliderEnabled) throw new LoyaltyError("SLIDER_OFF", "Choose one of the rewards instead.");
  const p = Number.parseInt(points, 10);
  const step = Math.max(1, settings.sliderStep);
  if (!Number.isFinite(p) || p <= 0 || p % step !== 0) {
    throw new LoyaltyError("BAD_AMOUNT", `Redeem points in steps of ${step}.`);
  }
  if (p < settings.sliderMinPoints) {
    throw new LoyaltyError("BAD_AMOUNT", `The minimum is ${settings.sliderMinPoints} points.`);
  }
  const value = pointsToMoney(p, settings.pointValue);
  return {
    reward: null,
    points: p,
    rewardType: "FIXED_AMOUNT",
    value,
    label: rewardLabel("FIXED_AMOUNT", value, settings.currencyCode),
    minSubtotal: minimumSubtotalFor(value, settings.maxRedeemPercent, 0),
  };
}

/**
 * Spends points and issues a reward. Points are taken inside a locked
 * transaction first; if Shopify then refuses the discount, the exact points
 * are put back. Returns the customer-facing code.
 */
export async function redeem(shop, customerMemberId, request, admin) {
  const settings = await getSettings(shop);
  const member = await prisma.member.findUniqueOrThrow({ where: { id: customerMemberId } });
  if (member.excluded) throw new LoyaltyError("EXCLUDED", "Rewards aren't available on this account.", 403);

  const asStoreCredit = request.kind === "STORE_CREDIT";
  if (asStoreCredit && !settings.storeCreditEnabled) {
    throw new LoyaltyError("STORE_CREDIT_OFF", "Store credit isn't available.");
  }
  await guardRate(member.id);
  const offer = await resolveOffer(shop, settings, member, request);
  if (asStoreCredit && offer.rewardType !== "FIXED_AMOUNT") {
    throw new LoyaltyError("BAD_REWARD", "Only ₹ rewards can go to store credit.");
  }

  const effects = [];
  const code = asStoreCredit ? null : `${settings.codePrefix}-${randomCode(8)}`;
  const expiresAt = addDays(new Date(), settings.codeExpiryDays);

  const { redemption, debit } = await withMemberLock(member.id, async (tx, locked) => {
    const redemption = await tx.redemption.create({
      data: {
        shop,
        memberId: locked.id,
        rewardId: offer.reward?.id ?? null,
        kind: asStoreCredit ? "STORE_CREDIT" : "DISCOUNT_CODE",
        points: offer.points,
        rewardType: offer.rewardType,
        value: offer.value,
        label: offer.label,
        code,
        minSubtotal: asStoreCredit ? null : offer.minSubtotal,
        status: "PENDING",
        expiresAt: asStoreCredit ? null : expiresAt,
      },
    });
    const { entry } = await debitPoints(
      tx,
      locked,
      {
        points: offer.points,
        type: "REDEMPTION",
        key: `redeem:${redemption.id}`,
        description: `Redeemed ${offer.label}`,
        meta: { redemptionId: redemption.id },
      },
      effects,
    );
    return { redemption, debit: entry };
  });

  try {
    let discountNodeId = null;
    if (asStoreCredit) {
      await creditStoreCredit(admin, {
        customerId: member.customerId,
        amount: offer.value,
        currencyCode: settings.currencyCode,
        expiresAt: settings.expiryDays > 0 ? addDays(new Date(), settings.expiryDays) : null,
      });
    } else {
      const created = await createRewardDiscount(admin, settings, {
        customerId: member.customerId,
        code,
        title: `${settings.programName}: ${offer.label} (${code})`,
        rewardType: offer.rewardType,
        value: offer.value,
        minSubtotal: offer.minSubtotal,
        endsAt: expiresAt,
      });
      discountNodeId = created.id;
    }
    const issued = await prisma.redemption.update({
      where: { id: redemption.id },
      data: { status: asStoreCredit ? "USED" : "ISSUED", discountNodeId, usedAt: asStoreCredit ? new Date() : null },
    });
    effects.push({ kind: "reward_redeemed", memberId: member.id, points: offer.points, code, label: offer.label });
    await runEffects(shop, effects, admin);
    const after = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    return {
      redemption: issued,
      code,
      label: offer.label,
      minSubtotal: issued.minSubtotal,
      expiresAt: issued.expiresAt,
      applyUrl: code ? `/discount/${encodeURIComponent(code)}?redirect=%2Fcart` : null,
      balance: after.balance,
    };
  } catch (err) {
    console.error(`[club] reward issue failed for redemption ${redemption.id}:`, err.message);
    const rollbackEffects = [];
    await withMemberLock(member.id, async (tx, locked) => {
      await restoreDebit(
        tx,
        locked,
        debit,
        { key: `restore:${redemption.id}`, description: "Points returned: reward could not be issued" },
        rollbackEffects,
      );
      await tx.redemption.update({ where: { id: redemption.id }, data: { status: "FAILED" } });
    });
    await runEffects(shop, rollbackEffects, admin);
    throw new LoyaltyError("ISSUE_FAILED", "We couldn't create your reward. Your points are safe, please try again.", 502);
  }
}

/** Cron: mark codes past their end date as expired. */
export async function expireCodes(shop, now = new Date()) {
  const res = await prisma.redemption.updateMany({
    where: { shop, status: "ISSUED", expiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });
  return { expired: res.count };
}
