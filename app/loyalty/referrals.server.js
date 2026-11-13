import prisma from "../db.server";
import { creditPoints, withMemberLock, LoyaltyError } from "./ledger.server";

const CLAIM_WINDOW_DAYS = 30;

/**
 * Links a new member to the friend who referred them and gives the friend
 * bonus. Rules: program on, member has no orders yet, joined recently, not
 * already referred, and not referring themselves.
 */
export async function claimReferral(shop, member, rawCode, settings, effects = [], { viaCheckout = false } = {}) {
  const rule = settings.earnRules.referral;
  if (!rule.enabled) throw new LoyaltyError("REFERRALS_OFF", "Referrals are not running right now.");
  const code = String(rawCode || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,20}$/.test(code)) throw new LoyaltyError("BAD_CODE", "That referral link doesn't look right.");
  if (member.referredById) return { already: true };

  const referrer = await prisma.member.findUnique({ where: { shop_referralCode: { shop, referralCode: code } } });
  if (!referrer) throw new LoyaltyError("BAD_CODE", "We couldn't find that referral link.");
  if (referrer.id === member.id) throw new LoyaltyError("SELF_REFERRAL", "You can't refer yourself.");
  if (referrer.email && member.email && referrer.email === member.email) {
    throw new LoyaltyError("SELF_REFERRAL", "You can't refer yourself.");
  }
  if (referrer.referredById === member.id) throw new LoyaltyError("CIRCULAR", "That referral isn't allowed.");
  if (referrer.excluded) throw new LoyaltyError("BAD_CODE", "That referral link isn't active.");

  const ageDays = (Date.now() - new Date(member.createdAt).getTime()) / 86400000;
  const previousOrders = await prisma.loyaltyOrder.count({ where: { memberId: member.id } });
  if (previousOrders > 0 || member.ordersCount > 0) {
    throw new LoyaltyError("NOT_NEW", "Referral rewards are for first orders only.");
  }
  if (!viaCheckout && ageDays > CLAIM_WINDOW_DAYS) {
    throw new LoyaltyError("NOT_NEW", "Referral rewards are for new members only.");
  }

  return withMemberLock(member.id, async (tx, locked) => {
    if (locked.referredById) return { already: true };
    await tx.member.update({ where: { id: locked.id }, data: { referredById: referrer.id } });
    locked.referredById = referrer.id;
    await tx.referral.create({
      data: { shop, referrerId: referrer.id, refereeId: locked.id, status: "SIGNED_UP" },
    });
    const { entry } = await creditPoints(
      tx,
      locked,
      settings,
      {
        points: rule.friendPoints,
        type: "REFERRAL_FRIEND",
        key: `referral-friend:${locked.id}`,
        description: `Welcome gift from ${referrer.firstName || "a friend"}`,
      },
      effects,
    );
    return { linked: true, points: entry?.points || 0, referrerName: referrer.firstName || null };
  });
}

export async function linkReferralFromCheckout(shop, member, code, settings, effects) {
  try {
    return await claimReferral(shop, member, code, settings, effects, { viaCheckout: true });
  } catch (err) {
    if (err instanceof LoyaltyError) return { rejected: err.code };
    throw err;
  }
}

/** When a referred friend's first order ships, reward the referrer (subject to the monthly cap). */
export async function qualifyReferralOnFulfilment(shop, refereeId, orderId, settings, effects = []) {
  const rule = settings.earnRules.referral;
  const referral = await prisma.referral.findUnique({ where: { refereeId } });
  if (!referral || referral.status !== "SIGNED_UP") return { skipped: true };

  const first = await prisma.loyaltyOrder.findFirst({
    where: { memberId: refereeId, status: { not: "CANCELLED" } },
    orderBy: { paidAt: "asc" },
  });
  if (!first || first.orderId !== orderId) return { skipped: "not_first_order" };

  if (!rule.enabled) return { skipped: "off" };

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const thisMonth = await prisma.referral.count({
    where: { referrerId: referral.referrerId, status: "REWARDED", updatedAt: { gte: monthStart } },
  });
  if (rule.monthlyCap > 0 && thisMonth >= rule.monthlyCap) {
    await prisma.referral.update({
      where: { id: referral.id },
      data: { status: "REJECTED", rejectReason: "Referrer hit the monthly referral cap", orderId },
    });
    return { rejected: "cap" };
  }

  return withMemberLock(referral.referrerId, async (tx, referrer) => {
    const fresh = await tx.referral.findUniqueOrThrow({ where: { id: referral.id } });
    if (fresh.status !== "SIGNED_UP") return { skipped: true };
    const referee = await tx.member.findUnique({ where: { id: refereeId } });
    await creditPoints(
      tx,
      referrer,
      settings,
      {
        points: rule.referrerPoints,
        type: "REFERRAL_REFERRER",
        key: `referral:${referral.id}`,
        description: `${referee?.firstName || "Your friend"} placed their first order`,
        meta: { refereeId, orderId },
      },
      effects,
    );
    await tx.referral.update({ where: { id: referral.id }, data: { status: "REWARDED", orderId } });
    return { rewarded: true };
  });
}
