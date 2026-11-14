import prisma from "../db.server";
import { getActiveRewards, getSettings, getTiers } from "./settings.server";
import { ensureMember, findMember } from "./members.server";
import { recordSignIn, setBirthday, startInstagramVerification } from "./actions.server";
import { claimReferral } from "./referrals.server";
import { redeem } from "./redeem.server";
import { LoyaltyError } from "./ledger.server";
import { formatMoney, maxSliderPoints, minimumSubtotalFor, nextTierProgress, pointsToMoney, rankOf } from "./math";
import { LEDGER_LABELS } from "./defaults";
import { programActiveFor } from "./orders.server";
import { runEffects } from "./effects.server";

function publicTier(t) {
  return t ? { id: t.id, name: t.name, threshold: t.threshold, multiplier: t.multiplier, perks: t.perks, color: t.color } : null;
}

function earnList(settings, member) {
  const r = settings.earnRules;
  const list = [];
  const rate = settings.pointsPerCurrency;
  if (r.purchase.enabled) {
    const pct = Math.round(rate * 1000) / 10;
    list.push({ key: "purchase", title: "Shop", points: null, detail: `${pct}% back in coins on every order`, status: "always" });
  }
  if (r.signup.enabled) {
    list.push({ key: "signup", title: "Create an account", points: r.signup.points, status: member?.signedInAt ? "done" : "available" });
  }
  if (r.birthdaySetup.enabled || r.birthday.enabled) {
    list.push({
      key: "birthday",
      title: "Add your birthday",
      points: r.birthdaySetup.enabled ? r.birthdaySetup.points : 0,
      detail: r.birthday.enabled ? `Plus ${r.birthday.points} coins every birthday` : null,
      status: member?.birthMonth ? "done" : "available",
    });
  }
  if (r.review.enabled || r.photoReview.enabled) {
    list.push({
      key: "review",
      title: "Review what you bought",
      points: r.review.enabled ? r.review.points : r.photoReview.points,
      detail: r.photoReview.enabled ? `${r.photoReview.points} with a photo` : null,
      status: "repeat",
    });
  }
  if (r.referral.enabled) {
    list.push({
      key: "referral",
      title: "Refer a friend",
      points: r.referral.referrerPoints,
      detail: `They get ${r.referral.friendPoints} coins when they join, you get yours when their order is delivered`,
      friendPoints: r.referral.friendPoints,
      status: "repeat",
    });
  }
  if (r.streak?.enabled) {
    list.push({
      key: "streak",
      title: `Order streak`,
      points: r.streak.points,
      detail: `Every ${r.streak.orders} orders within ${r.streak.windowDays} days`,
      status: "repeat",
    });
  }
  if (r.instagram.enabled) {
    list.push({ key: "instagram", title: `Follow @${r.instagram.handle}`, points: r.instagram.points, status: member?.instagramId ? "done" : "available" });
  }
  if (r.newsletter.enabled) {
    list.push({ key: "newsletter", title: "Join the newsletter", points: r.newsletter.points, status: "available" });
  }
  return list;
}

function rewardList(settings, rewards, tiers, member, cartSubtotal) {
  const balance = member?.balance ?? 0;
  const myRank = member ? rankOf(tiers, tiers.find((t) => t.id === member.tierId)) : -1;
  return rewards.map((rw) => {
    const minSubtotal =
      rw.type === "FIXED_AMOUNT"
        ? minimumSubtotalFor(rw.value, settings.maxRedeemPercent, Math.max(rw.minSubtotal || 0, settings.minRedeemSubtotal || 0))
        : rw.minSubtotal || null;
    const tierLocked = rw.minTierId ? myRank < rankOf(tiers, tiers.find((t) => t.id === rw.minTierId)) : false;
    return {
      id: rw.id,
      title: rw.title,
      type: rw.type,
      points: rw.pointsCost,
      value: rw.value,
      minSubtotal,
      minTier: rw.minTier?.name || null,
      pointsNeeded: Math.max(0, rw.pointsCost - balance),
      cartTooSmall: cartSubtotal != null && minSubtotal ? cartSubtotal < minSubtotal : false,
      canRedeem: !!member && !member.excluded && balance >= rw.pointsCost && !tierLocked,
      tierLocked,
    };
  });
}

/**
 * Everything a storefront surface needs in one call. `customerId` is the
 * verified signed-in customer, or null for guests.
 */
export async function buildState(shop, customerId, { cartSubtotal = null, admin = null, profile = {} } = {}) {
  const [settings, tiers, rewards] = await Promise.all([getSettings(shop), getTiers(shop), getActiveRewards(shop)]);
  const program = {
    name: settings.programName,
    live: settings.isLive,
    currency: settings.currencyCode,
    pointValue: settings.pointValue,
    pointsPerCurrency: settings.pointsPerCurrency,
    maxRedeemPercent: settings.maxRedeemPercent,
    minRedeemSubtotal: settings.minRedeemSubtotal,
    earnPercent: Math.round(settings.pointsPerCurrency * 1000) / 10,
    tierWindowDays: settings.downgradeAfterDays,
    expiryDays: settings.expiryDays,
    slider: settings.sliderEnabled ? { step: settings.sliderStep, min: settings.sliderMinPoints } : null,
    storeCredit: settings.storeCreditEnabled,
    tiers: tiers.map(publicTier),
    widget: settings.widget,
    // Full-page account extensions have no shopify.shop, so the referral link needs this.
    storefrontUrl: `https://${shop}`,
  };

  let member = null;
  if (customerId) {
    member = await findMember(shop, customerId);
    const tags = profile.tags || [];
    const active = programActiveFor(settings, tags) || !!member;
    if (active) {
      member = member || (await ensureMember(shop, customerId, profile));
      member = await recordSignIn(shop, member, settings, admin);
    }
  }

  if (!member) {
    return {
      program,
      member: null,
      earn: earnList(settings, null),
      rewards: rewardList(settings, rewards, tiers, null, cartSubtotal),
    };
  }

  const [ledger, codes, referrals] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { memberId: member.id, NOT: { status: "CANCELLED" } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.redemption.findMany({
      where: { memberId: member.id, status: "ISSUED", kind: "DISCOUNT_CODE" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.referral.groupBy({ by: ["status"], where: { referrerId: member.id }, _count: true }),
  ]);

  const progress = nextTierProgress(tiers, member.tierSpend || 0);
  const nextExpiry = await prisma.ledgerEntry.findFirst({
    where: { memberId: member.id, status: "AVAILABLE", remaining: { gt: 0 }, expiresAt: { not: null } },
    orderBy: { expiresAt: "asc" },
    select: { expiresAt: true, remaining: true },
  });

  return {
    program,
    member: {
      firstName: member.firstName,
      balance: member.balance,
      pending: member.pending,
      worth: pointsToMoney(member.balance, settings.pointValue),
      // Whole rupees: redemption happens in steps, so paise would only be noise.
      worthLabel: formatMoney(Math.floor(pointsToMoney(member.balance, settings.pointValue)), settings.currencyCode),
      lifetimeEarned: member.lifetimeEarned,
      excluded: member.excluded,
      memberSince: member.createdAt,
      tier: publicTier(tiers.find((t) => t.id === member.tierId)),
      // Tiers run on ₹ spend: amountNeeded is ₹ more to spend (pointsNeeded kept for older surfaces).
      tierSpend: member.tierSpend || 0,
      nextTier: progress.next
        ? { ...publicTier(progress.next), amountNeeded: progress.pointsNeeded, pointsNeeded: progress.pointsNeeded }
        : null,
      tierProgress: progress.progress,
      birthdaySet: !!member.birthMonth,
      instagramVerified: !!member.instagramId,
      nextExpiry: nextExpiry ? { date: nextExpiry.expiresAt, points: nextExpiry.remaining } : null,
      referral: {
        code: member.referralCode,
        signedUp: referrals.reduce((s, r) => s + r._count, 0),
        rewarded: referrals.find((r) => r.status === "REWARDED")?._count || 0,
      },
      slider:
        settings.sliderEnabled && cartSubtotal != null
          ? {
              // Below the minimum cart, nothing can be used yet; cartShortBy says how far off it is.
              max:
                cartSubtotal >= (settings.minRedeemSubtotal || 0)
                  ? maxSliderPoints({
                      balance: member.balance,
                      cartSubtotal,
                      pointValue: settings.pointValue,
                      maxRedeemPercent: settings.maxRedeemPercent,
                      step: settings.sliderStep,
                    })
                  : 0,
              cartShortBy: Math.max(0, Math.ceil((settings.minRedeemSubtotal || 0) - cartSubtotal)),
            }
          : null,
    },
    earn: earnList(settings, member),
    rewards: rewardList(settings, rewards, tiers, member, cartSubtotal),
    codes: codes.map((c) => ({
      code: c.code,
      label: c.label,
      minSubtotal: c.minSubtotal,
      expiresAt: c.expiresAt,
      applyUrl: `/discount/${encodeURIComponent(c.code)}?redirect=%2Fcart`,
    })),
    history: ledger.map((e) => ({
      id: e.id,
      date: e.createdAt,
      points: e.points,
      pending: e.status === "PENDING",
      label: LEDGER_LABELS[e.type] || e.type,
      description: e.description,
    })),
  };
}

async function requireMember(shop, customerId) {
  if (!customerId) throw new LoyaltyError("SIGN_IN", "Sign in to use your coins.", 401);
  const settings = await getSettings(shop);
  const member = await findMember(shop, customerId);
  if (!member) {
    if (!settings.isLive) throw new LoyaltyError("NOT_LIVE", "The club opens soon.", 403);
    return ensureMember(shop, customerId);
  }
  return member;
}

/** Dispatches a storefront action for a verified customer. */
export async function performAction(shop, customerId, action, body, admin) {
  const member = await requireMember(shop, customerId);
  switch (action) {
    case "redeem":
      return redeem(shop, member.id, { rewardId: body.rewardId, points: body.points, kind: body.kind, cartSubtotal: body.cartSubtotal }, admin);
    case "birthday":
      await setBirthday(shop, member, body, admin);
      return { ok: true };
    case "referral": {
      const settings = await getSettings(shop);
      const effects = [];
      const res = await claimReferral(shop, member, body.code, settings, effects);
      await runEffects(shop, effects, admin);
      return res;
    }
    case "instagram":
      return startInstagramVerification(shop, member);
    default:
      throw new LoyaltyError("UNKNOWN_ACTION", "Unknown action.", 404);
  }
}
