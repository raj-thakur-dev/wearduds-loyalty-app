import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fakeAdmin, resetDb, orderPayload, assertInvariant } from "./helpers";
import prisma from "../app/db.server";
import { getSettings, updateSettings } from "../app/loyalty/settings.server";
import { handleFulfillment, handleOrderCancelled, handleOrderPaid, handleRefund, releaseDueOrders } from "../app/loyalty/orders.server";
import { redeem } from "../app/loyalty/redeem.server";
import { findMember, ensureMember } from "../app/loyalty/members.server";
import { adjustPoints, awardBirthdays, awardReview, recordSignIn, setBirthday } from "../app/loyalty/actions.server";
import { claimReferral } from "../app/loyalty/referrals.server";
import { expirePoints, refreshTiers, warnExpiringPoints } from "../app/loyalty/jobs.server";
import { buildState } from "../app/loyalty/storefront.server";
import { addDays } from "../app/loyalty/math";

const SHOP = "wearduds-test.myshopify.com";
const DAY = 86400000;

async function live() {
  await getSettings(SHOP);
  return updateSettings(SHOP, { isLive: true });
}

/**
 * The original points economics (1 point per ₹1, 100 points = ₹10, ₹ code
 * rewards). The ledger mechanics tests below run on these numbers so they stay
 * readable; the "coins program" tests cover the live defaults.
 */
async function legacy() {
  await live();
  await prisma.reward.createMany({
    data: [
      { shop: SHOP, title: "₹50 off", type: "FIXED_AMOUNT", value: 50, pointsCost: 500, minSubtotal: 500, sortOrder: 0 },
      { shop: SHOP, title: "₹100 off", type: "FIXED_AMOUNT", value: 100, pointsCost: 1000, minSubtotal: 800, sortOrder: 1 },
      { shop: SHOP, title: "₹250 off", type: "FIXED_AMOUNT", value: 250, pointsCost: 2500, minSubtotal: 1500, sortOrder: 2 },
      { shop: SHOP, title: "₹500 off", type: "FIXED_AMOUNT", value: 500, pointsCost: 5000, minSubtotal: 3000, sortOrder: 3 },
    ],
  });
  return updateSettings(SHOP, {
    pointsPerCurrency: 1,
    pointValue: 0.1,
    expiryDays: 365,
    sliderStep: 100,
    sliderMinPoints: 500,
    minRedeemSubtotal: 0,
    storeCreditEnabled: false,
    downgradeAfterDays: 365,
    earnRules: {
      signup: { enabled: true, points: 100 },
      birthdaySetup: { enabled: true, points: 50 },
      birthday: { enabled: true, points: 200, daysBefore: 3 },
      review: { enabled: true, points: 50, minWords: 20, requireVerifiedBuyer: true },
      photoReview: { enabled: true, points: 100 },
      referral: { enabled: true, referrerPoints: 300, friendPoints: 100, monthlyCap: 10 },
      streak: { enabled: false, points: 0, orders: 3, windowDays: 90 },
    },
  });
}

/** Pays an order, delivers it, and releases points 8 days later. */
async function earn(customerId, amount) {
  const order = orderPayload({ customerId, amount });
  await handleOrderPaid(SHOP, order, fakeAdmin);
  fakeAdmin.state.delivery[order.id] = { fulfilledAt: new Date().toISOString(), deliveredAt: new Date().toISOString() };
  await handleFulfillment(SHOP, { order_id: order.id, status: "success", created_at: new Date().toISOString() }, fakeAdmin);
  await releaseDueOrders(SHOP, new Date(Date.now() + 8 * DAY));
  return order;
}

beforeEach(async () => {
  await resetDb(prisma);
  fakeAdmin.calls.length = 0;
  fakeAdmin.state.failDiscount = false;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("purchase points", () => {
  it("parks points as pending until delivery + 7 days, then unlocks them", async () => {
    await legacy();
    const order = orderPayload({ customerId: 11, amount: 1999 });
    await handleOrderPaid(SHOP, order, fakeAdmin);
    let m = await findMember(SHOP, 11);
    expect(m.pending).toBe(1999);
    expect(m.balance).toBe(0);

    // Nothing unlocks before delivery is known.
    await releaseDueOrders(SHOP, new Date(Date.now() + 30 * DAY));
    expect((await findMember(SHOP, 11)).balance).toBe(0);

    const delivered = new Date();
    fakeAdmin.state.delivery[order.id] = { fulfilledAt: delivered.toISOString(), deliveredAt: delivered.toISOString() };
    await handleFulfillment(SHOP, { order_id: order.id, status: "success", created_at: delivered.toISOString() }, fakeAdmin);

    await releaseDueOrders(SHOP, new Date(delivered.getTime() + 6 * DAY));
    expect((await findMember(SHOP, 11)).balance).toBe(0);
    await releaseDueOrders(SHOP, new Date(delivered.getTime() + 7 * DAY + 1000));
    m = await assertInvariant(prisma, (await findMember(SHOP, 11)).id, expect);
    expect(m.balance).toBe(1999);
    expect(m.pending).toBe(0);
    expect(m.lifetimeEarned).toBe(1999);
  });

  it("ignores duplicate webhooks", async () => {
    await legacy();
    const order = orderPayload({ customerId: 12, amount: 500 });
    await handleOrderPaid(SHOP, order, fakeAdmin);
    await handleOrderPaid(SHOP, order, fakeAdmin);
    const m = await findMember(SHOP, 12);
    expect(m.pending).toBe(500);
    expect(await prisma.ledgerEntry.count({ where: { memberId: m.id } })).toBe(1);
  });

  it("does not earn before launch unless the customer is a tester", async () => {
    await getSettings(SHOP);
    await handleOrderPaid(SHOP, orderPayload({ customerId: 13, amount: 500 }), fakeAdmin);
    expect(await findMember(SHOP, 13)).toBeNull();
    await handleOrderPaid(SHOP, orderPayload({ customerId: 14, amount: 500, tags: "vip, club-tester" }), fakeAdmin);
    expect((await findMember(SHOP, 14)).pending).toBe(15); // 3% of ₹500
  });

  it("upgrades tier on ₹ spend once the return window passes and applies the new multiplier", async () => {
    await legacy();
    await earn(15, 5200);
    let m = await findMember(SHOP, 15);
    const gold = await prisma.tier.findFirst({ where: { shop: SHOP, name: "Gold" } });
    expect(m.tierId).toBe(gold.id);
    expect(m.tierSpend).toBe(5200);
    await handleOrderPaid(SHOP, orderPayload({ customerId: 15, amount: 1000 }), fakeAdmin);
    m = await findMember(SHOP, 15);
    expect(m.pending).toBe(1250);
    expect(fakeAdmin.calls.some((c) => c.name === "ClubFlow" && c.variables.handle === "club-tier-changed")).toBe(true);
  });
});

describe("refunds and cancellations", () => {
  it("shrinks pending points on a partial refund and ignores repeats", async () => {
    await legacy();
    const order = orderPayload({ customerId: 21, amount: 2000 });
    await handleOrderPaid(SHOP, order, fakeAdmin);
    const refund = { id: 9001, order_id: order.id, refund_line_items: [{ subtotal: "500.00", line_item: {} }] };
    await handleRefund(SHOP, refund, fakeAdmin);
    await handleRefund(SHOP, refund, fakeAdmin);
    const m = await assertInvariant(prisma, (await findMember(SHOP, 21)).id, expect);
    expect(m.pending).toBe(1500);
  });

  it("claws back released points on refund without going negative", async () => {
    await legacy();
    const order = await earn(22, 1000);
    const m0 = await findMember(SHOP, 22);
    await adjustPoints(SHOP, m0.id, { points: -800, reason: "test spend", staff: "t" }, fakeAdmin);
    await handleRefund(SHOP, { id: 9002, order_id: order.id, refund_line_items: [{ subtotal: "1000.00", line_item: {} }] }, fakeAdmin);
    const m = await assertInvariant(prisma, m0.id, expect);
    expect(m.balance).toBe(0);
    expect(m.lifetimeEarned).toBe(0);
  });

  it("cancels pending points and returns points spent on a reward used in that order", async () => {
    await legacy();
    await earn(23, 1000);
    const member = await findMember(SHOP, 23);
    const reward = await prisma.reward.findFirst({ where: { shop: SHOP, pointsCost: 500 } });
    const issued = await redeem(SHOP, member.id, { rewardId: reward.id }, fakeAdmin);
    expect((await findMember(SHOP, 23)).balance).toBe(500);

    const order = orderPayload({ customerId: 23, amount: 600, codes: [issued.code] });
    await handleOrderPaid(SHOP, order, fakeAdmin);
    expect((await prisma.redemption.findUnique({ where: { id: issued.redemption.id } })).status).toBe("USED");

    await handleOrderCancelled(SHOP, order, fakeAdmin);
    const m = await assertInvariant(prisma, member.id, expect);
    expect(m.pending).toBe(0);
    expect(m.balance).toBe(1000);
  });
});

describe("redemption", () => {
  it("issues a code locked to the customer with the minimum order", async () => {
    await legacy();
    await earn(31, 3000);
    const member = await findMember(SHOP, 31);
    const reward = await prisma.reward.findFirst({ where: { shop: SHOP, pointsCost: 1000 } });
    const res = await redeem(SHOP, member.id, { rewardId: reward.id }, fakeAdmin);
    expect(res.code).toMatch(/^WD-[A-Z2-9]{8}$/);
    const call = fakeAdmin.calls.find((c) => c.name === "ClubDiscount");
    expect(call.variables.input.context).toEqual({ customers: { add: ["gid://shopify/Customer/31"] } });
    expect(call.variables.input.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal).toBe("800");
    expect(call.variables.input.usageLimit).toBe(1);
    expect(call.variables.input.customerGets.value.discountAmount.amount).toBe("100");
    const m = await assertInvariant(prisma, member.id, expect);
    expect(m.balance).toBe(2000);
  });

  it("converts slider points at 100 = ₹10 with a 20% cap", async () => {
    await legacy();
    await earn(32, 3000);
    const member = await findMember(SHOP, 32);
    const res = await redeem(SHOP, member.id, { points: 1300 }, fakeAdmin);
    expect(res.label).toBe("₹130 off");
    expect(res.minSubtotal).toBe(650);
    await expect(redeem(SHOP, member.id, { points: 150 }, fakeAdmin)).rejects.toThrow(/steps of 100/);
  });

  it("refuses when points are short", async () => {
    await legacy();
    await earn(33, 400);
    const member = await findMember(SHOP, 33);
    const reward = await prisma.reward.findFirst({ where: { shop: SHOP, pointsCost: 500 } });
    await expect(redeem(SHOP, member.id, { rewardId: reward.id }, fakeAdmin)).rejects.toThrow(/enough coins/);
    await assertInvariant(prisma, member.id, expect);
  });

  it("never overspends under concurrent redemptions", async () => {
    await legacy();
    await earn(34, 1200);
    const member = await findMember(SHOP, 34);
    const reward = await prisma.reward.findFirst({ where: { shop: SHOP, pointsCost: 500 } });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => redeem(SHOP, member.id, { rewardId: reward.id }, fakeAdmin)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const m = await assertInvariant(prisma, member.id, expect);
    expect(m.balance).toBe(200);
  });

  it("puts the points back when Shopify refuses the discount", async () => {
    await legacy();
    await earn(35, 1000);
    const member = await findMember(SHOP, 35);
    fakeAdmin.state.failDiscount = true;
    const reward = await prisma.reward.findFirst({ where: { shop: SHOP, pointsCost: 500 } });
    await expect(redeem(SHOP, member.id, { rewardId: reward.id }, fakeAdmin)).rejects.toThrow(/safe/);
    const m = await assertInvariant(prisma, member.id, expect);
    expect(m.balance).toBe(1000);
    expect(m.lifetimeSpent).toBe(0);
    expect(await prisma.redemption.count({ where: { memberId: member.id, status: "FAILED" } })).toBe(1);
  });
});

describe("expiry", () => {
  it("expires the oldest points first and keeps the ledger consistent", async () => {
    await legacy();
    await earn(41, 1000);
    const member = await findMember(SHOP, 41);
    await expirePoints(SHOP, new Date(Date.now() + 400 * DAY));
    const m = await assertInvariant(prisma, member.id, expect);
    expect(m.balance).toBe(0);
    expect(m.lifetimeEarned).toBe(1000);
  });
});

describe("earn actions", () => {
  it("gives the welcome bonus once, on first sign-in", async () => {
    const settings = await legacy();
    const member = await ensureMember(SHOP, 51, { firstName: "Arjun" });
    await recordSignIn(SHOP, member, settings, fakeAdmin);
    await recordSignIn(SHOP, await findMember(SHOP, 51), settings, fakeAdmin);
    expect((await findMember(SHOP, 51)).balance).toBe(100);
  });

  it("rewards adding a birthday once and the birthday itself once a year", async () => {
    await legacy();
    const member = await ensureMember(SHOP, 52);
    const soon = addDays(new Date(), 2);
    await setBirthday(SHOP, member, { month: soon.getUTCMonth() + 1, day: soon.getUTCDate() }, fakeAdmin);
    await expect(setBirthday(SHOP, await findMember(SHOP, 52), { month: 1, day: 1 }, fakeAdmin)).rejects.toThrow(/already saved/);
    await awardBirthdays(SHOP);
    await awardBirthdays(SHOP);
    expect((await findMember(SHOP, 52)).balance).toBe(250);
  });

  it("rewards reviews and tops up when a photo is added", async () => {
    await legacy();
    const member = await ensureMember(SHOP, 53, { email: "rev@example.com" });
    const body = "Heavy fabric, the fit is properly oversized and it survived ten washes without fading at all, honestly great value for the price";
    await awardReview(SHOP, { email: "REV@example.com", reviewId: "r1", body, hasPhoto: false });
    await awardReview(SHOP, { email: "rev@example.com", reviewId: "r1", body, hasPhoto: false });
    expect((await findMember(SHOP, 53)).balance).toBe(50);
    await awardReview(SHOP, { customerId: 53, reviewId: "r1", body, hasPhoto: true });
    expect((await findMember(SHOP, 53)).balance).toBe(100);
    await awardReview(SHOP, { customerId: 53, reviewId: "r2", body: "nice", hasPhoto: false });
    await assertInvariant(prisma, member.id, expect);
    expect((await findMember(SHOP, 53)).balance).toBe(100);
  });
});

describe("referrals", () => {
  it("rewards the friend on signup and the referrer when the first order ships", async () => {
    const settings = await legacy();
    const referrer = await ensureMember(SHOP, 61, { firstName: "Riya", email: "riya@example.com" });
    const friend = await ensureMember(SHOP, 62, { firstName: "Kabir", email: "kabir@example.com" });

    await expect(claimReferral(SHOP, referrer, referrer.referralCode, settings)).rejects.toThrow(/yourself/);
    await claimReferral(SHOP, friend, referrer.referralCode, settings);
    expect((await findMember(SHOP, 62)).balance).toBe(100);

    const order = orderPayload({ customerId: 62, amount: 1500 });
    await handleOrderPaid(SHOP, order, fakeAdmin);
    expect((await findMember(SHOP, 61)).balance).toBe(0);
    fakeAdmin.state.delivery[order.id] = { fulfilledAt: new Date().toISOString() };
    await handleFulfillment(SHOP, { order_id: order.id, status: "success", created_at: new Date().toISOString() }, fakeAdmin);
    await handleFulfillment(SHOP, { order_id: order.id, status: "success", created_at: new Date().toISOString() }, fakeAdmin);
    expect((await findMember(SHOP, 61)).balance).toBe(300);
    expect((await prisma.referral.findUnique({ where: { refereeId: friend.id } })).status).toBe("REWARDED");
  });

  it("links a referral passed through the cart at checkout", async () => {
    await legacy();
    const referrer = await ensureMember(SHOP, 63, { firstName: "Dev" });
    await handleOrderPaid(SHOP, orderPayload({ customerId: 64, amount: 900, refCode: referrer.referralCode }), fakeAdmin);
    const friend = await findMember(SHOP, 64);
    expect(friend.referredById).toBe(referrer.id);
    expect(friend.balance).toBe(100);
  });
});

describe("tier refresh", () => {
  it("drops a tier when spend falls out of the 12-month window", async () => {
    await legacy();
    await earn(71, 6000);
    const m0 = await findMember(SHOP, 71);
    const gold = await prisma.tier.findFirst({ where: { shop: SHOP, name: "Gold" } });
    expect(m0.tierId).toBe(gold.id);
    // 13 months later the order no longer counts.
    await refreshTiers(SHOP, new Date(Date.now() + 400 * DAY));
    const m = await findMember(SHOP, 71);
    const silver = await prisma.tier.findFirst({ where: { shop: SHOP, name: "Silver" } });
    expect(m.tierId).toBe(silver.id);
    expect(m.tierSpend).toBe(0);
    const state = await buildState(SHOP, 71);
    expect(state.member.nextTier.name).toBe("Gold");
    expect(state.member.nextTier.amountNeeded).toBe(5000);
  });

  it("drops a tier after a refund once the daily refresh runs", async () => {
    await legacy();
    const order = await earn(72, 5500);
    await handleRefund(SHOP, { id: 9072, order_id: order.id, refund_line_items: [{ subtotal: "1000.00", line_item: {} }] }, fakeAdmin);
    await refreshTiers(SHOP);
    const m = await findMember(SHOP, 72);
    expect(m.tierSpend).toBe(4500);
    expect((await prisma.tier.findUnique({ where: { id: m.tierId } })).name).toBe("Silver");
  });
});

describe("storefront state", () => {
  it("returns guest info without a customer and member info with one", async () => {
    await legacy();
    const guest = await buildState(SHOP, null);
    expect(guest.member).toBeNull();
    expect(guest.rewards).toHaveLength(4);
    expect(guest.program.tiers.map((t) => t.name)).toEqual(["Silver", "Gold", "Platinum"]);

    await earn(81, 2600);
    await updateSettings(SHOP, { minRedeemSubtotal: 0 });
    const state = await buildState(SHOP, 81, { cartSubtotal: 3000 });
    expect(state.member.balance).toBe(2700); // 2600 + 100 welcome bonus
    expect(state.member.worthLabel).toBe("₹270");
    expect(state.member.slider.max).toBe(2700);
    expect(state.rewards.find((r) => r.points === 2500).canRedeem).toBe(true);
    expect(state.rewards.find((r) => r.points === 5000).pointsNeeded).toBe(2300);
    expect(state.history[0].label).toBeTruthy();
  });
});

describe("coins program (live defaults)", () => {
  it("earns 3% back in coins, 1 coin = ₹1", async () => {
    await live();
    await earn(101, 1999);
    const m = await findMember(SHOP, 101);
    expect(m.balance).toBe(59);
    const state = await buildState(SHOP, 101);
    expect(state.member.worthLabel).toBe("₹69"); // 59 + 10 welcome coins
    expect(state.earn.find((e) => e.key === "purchase").detail).toBe("3% back in coins on every order");
    expect(state.rewards).toHaveLength(0);
  });

  it("turns coins into store credit from a cart of ₹1,499+ with a 20% cap", async () => {
    await live();
    await earn(102, 20000); // 600 coins
    const member = await findMember(SHOP, 102);
    expect(member.balance).toBe(600);

    await expect(redeem(SHOP, member.id, { points: 100, kind: "STORE_CREDIT" }, fakeAdmin)).rejects.toThrow(/from your cart/);
    await expect(redeem(SHOP, member.id, { points: 100, kind: "STORE_CREDIT", cartSubtotal: 1200 }, fakeAdmin)).rejects.toThrow(/₹1,499 or more/);
    await expect(redeem(SHOP, member.id, { points: 400, kind: "STORE_CREDIT", cartSubtotal: 1500 }, fakeAdmin)).rejects.toThrow(/up to 300 coins/);

    const state = await buildState(SHOP, 102, { cartSubtotal: 1200 });
    expect(state.member.slider).toEqual({ max: 0, cartShortBy: 299 });

    const res = await redeem(SHOP, member.id, { points: 300, kind: "STORE_CREDIT", cartSubtotal: 1500 }, fakeAdmin);
    expect(res.storeCredit).toEqual({ amount: 300, currency: "INR" });
    expect(res.checkoutUrl).toBe("/checkout");
    const call = fakeAdmin.calls.find((c) => c.name === "ClubStoreCredit");
    expect(call.variables.input.creditAmount).toEqual({ amount: "300", currencyCode: "INR" });
    const m = await assertInvariant(prisma, member.id, expect);
    expect(m.balance).toBe(310); // 600 + 10 welcome coins on first sign-in - 300
  });

  it("moves to Gold at ₹5,000 spend and pays 1.25x", async () => {
    await live();
    await earn(103, 5000);
    const m = await findMember(SHOP, 103);
    expect((await prisma.tier.findUnique({ where: { id: m.tierId } })).name).toBe("Gold");
    await handleOrderPaid(SHOP, orderPayload({ customerId: 103, amount: 1000 }), fakeAdmin);
    expect((await findMember(SHOP, 103)).pending).toBe(37); // 1000 × 3% × 1.25 = 37.5
  });

  it("pays the streak bonus on every 3rd order in 90 days", async () => {
    await live();
    await earn(104, 1000);
    await earn(104, 1000);
    expect((await findMember(SHOP, 104)).balance).toBe(60);
    await earn(104, 1000);
    const m = await assertInvariant(prisma, (await findMember(SHOP, 104)).id, expect);
    expect(m.balance).toBe(90 + 50);
    expect(await prisma.ledgerEntry.count({ where: { memberId: m.id, type: "STREAK" } })).toBe(1);
  });

  it("expires coins after 90 days and reminds at 30 and 7 days", async () => {
    await live();
    await earn(105, 2000);
    const m0 = await findMember(SHOP, 105);
    const credit = await prisma.ledgerEntry.findFirst({ where: { memberId: m0.id, type: "PURCHASE" } });
    const daysToExpiry = Math.round((credit.expiresAt - Date.now()) / DAY);
    expect(daysToExpiry).toBe(90);
    fakeAdmin.calls.length = 0;
    const flows = () => fakeAdmin.calls.filter((c) => c.name === "ClubFlow" && c.variables.handle === "club-points-expiring").length;
    await warnExpiringPoints(SHOP, addDays(credit.expiresAt, -30));
    expect(flows()).toBe(1);
    await warnExpiringPoints(SHOP, addDays(credit.expiresAt, -7));
    expect(flows()).toBe(2);
    await expirePoints(SHOP, addDays(credit.expiresAt, 1));
    expect((await assertInvariant(prisma, m0.id, expect)).balance).toBe(0);
  });
});
