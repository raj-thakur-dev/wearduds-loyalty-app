import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fakeAdmin, resetDb, orderPayload, assertInvariant } from "./helpers";
import prisma from "../app/db.server";
import { getSettings, updateSettings } from "../app/loyalty/settings.server";
import { handleFulfillment, handleOrderCancelled, handleOrderPaid, handleRefund, releaseDueOrders } from "../app/loyalty/orders.server";
import { redeem } from "../app/loyalty/redeem.server";
import { findMember, ensureMember } from "../app/loyalty/members.server";
import { adjustPoints, awardBirthdays, awardReview, recordSignIn, setBirthday } from "../app/loyalty/actions.server";
import { claimReferral } from "../app/loyalty/referrals.server";
import { expirePoints, downgradeInactive } from "../app/loyalty/jobs.server";
import { buildState } from "../app/loyalty/storefront.server";
import { addDays } from "../app/loyalty/math";

const SHOP = "wearduds-test.myshopify.com";
const DAY = 86400000;

async function live() {
  await getSettings(SHOP);
  return updateSettings(SHOP, { isLive: true });
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
    await live();
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
    await live();
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
    expect((await findMember(SHOP, 14)).pending).toBe(500);
  });

  it("upgrades tier on lifetime points and applies the new multiplier", async () => {
    await live();
    await earn(15, 5200);
    let m = await findMember(SHOP, 15);
    const gold = await prisma.tier.findFirst({ where: { shop: SHOP, name: "Gold" } });
    expect(m.tierId).toBe(gold.id);
    await handleOrderPaid(SHOP, orderPayload({ customerId: 15, amount: 1000 }), fakeAdmin);
    m = await findMember(SHOP, 15);
    expect(m.pending).toBe(1250);
    expect(fakeAdmin.calls.some((c) => c.name === "ClubFlow" && c.variables.handle === "club-tier-changed")).toBe(true);
  });
});

describe("refunds and cancellations", () => {
  it("shrinks pending points on a partial refund and ignores repeats", async () => {
    await live();
    const order = orderPayload({ customerId: 21, amount: 2000 });
    await handleOrderPaid(SHOP, order, fakeAdmin);
    const refund = { id: 9001, order_id: order.id, refund_line_items: [{ subtotal: "500.00", line_item: {} }] };
    await handleRefund(SHOP, refund, fakeAdmin);
    await handleRefund(SHOP, refund, fakeAdmin);
    const m = await assertInvariant(prisma, (await findMember(SHOP, 21)).id, expect);
    expect(m.pending).toBe(1500);
  });

  it("claws back released points on refund without going negative", async () => {
    await live();
    const order = await earn(22, 1000);
    const m0 = await findMember(SHOP, 22);
    await adjustPoints(SHOP, m0.id, { points: -800, reason: "test spend", staff: "t" }, fakeAdmin);
    await handleRefund(SHOP, { id: 9002, order_id: order.id, refund_line_items: [{ subtotal: "1000.00", line_item: {} }] }, fakeAdmin);
    const m = await assertInvariant(prisma, m0.id, expect);
    expect(m.balance).toBe(0);
    expect(m.lifetimeEarned).toBe(0);
  });

  it("cancels pending points and returns points spent on a reward used in that order", async () => {
    await live();
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
    await live();
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
    await live();
    await earn(32, 3000);
    const member = await findMember(SHOP, 32);
    const res = await redeem(SHOP, member.id, { points: 1300 }, fakeAdmin);
    expect(res.label).toBe("₹130 off");
    expect(res.minSubtotal).toBe(650);
    await expect(redeem(SHOP, member.id, { points: 150 }, fakeAdmin)).rejects.toThrow(/steps of 100/);
  });

  it("refuses when points are short", async () => {
    await live();
    await earn(33, 400);
    const member = await findMember(SHOP, 33);
    const reward = await prisma.reward.findFirst({ where: { shop: SHOP, pointsCost: 500 } });
    await expect(redeem(SHOP, member.id, { rewardId: reward.id }, fakeAdmin)).rejects.toThrow(/Not enough points/);
    await assertInvariant(prisma, member.id, expect);
  });

  it("never overspends under concurrent redemptions", async () => {
    await live();
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
    await live();
    await earn(35, 1000);
    const member = await findMember(SHOP, 35);
    fakeAdmin.state.failDiscount = true;
    const reward = await prisma.reward.findFirst({ where: { shop: SHOP, pointsCost: 500 } });
    await expect(redeem(SHOP, member.id, { rewardId: reward.id }, fakeAdmin)).rejects.toThrow(/points are safe/);
    const m = await assertInvariant(prisma, member.id, expect);
    expect(m.balance).toBe(1000);
    expect(m.lifetimeSpent).toBe(0);
    expect(await prisma.redemption.count({ where: { memberId: member.id, status: "FAILED" } })).toBe(1);
  });
});

describe("expiry", () => {
  it("expires the oldest points first and keeps the ledger consistent", async () => {
    await live();
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
    const settings = await live();
    const member = await ensureMember(SHOP, 51, { firstName: "Arjun" });
    await recordSignIn(SHOP, member, settings, fakeAdmin);
    await recordSignIn(SHOP, await findMember(SHOP, 51), settings, fakeAdmin);
    expect((await findMember(SHOP, 51)).balance).toBe(100);
  });

  it("rewards adding a birthday once and the birthday itself once a year", async () => {
    await live();
    const member = await ensureMember(SHOP, 52);
    const soon = addDays(new Date(), 2);
    await setBirthday(SHOP, member, { month: soon.getUTCMonth() + 1, day: soon.getUTCDate() }, fakeAdmin);
    await expect(setBirthday(SHOP, await findMember(SHOP, 52), { month: 1, day: 1 }, fakeAdmin)).rejects.toThrow(/already saved/);
    await awardBirthdays(SHOP);
    await awardBirthdays(SHOP);
    expect((await findMember(SHOP, 52)).balance).toBe(250);
  });

  it("rewards reviews and tops up when a photo is added", async () => {
    await live();
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
    const settings = await live();
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
    await live();
    const referrer = await ensureMember(SHOP, 63, { firstName: "Dev" });
    await handleOrderPaid(SHOP, orderPayload({ customerId: 64, amount: 900, refCode: referrer.referralCode }), fakeAdmin);
    const friend = await findMember(SHOP, 64);
    expect(friend.referredById).toBe(referrer.id);
    expect(friend.balance).toBe(100);
  });
});

describe("tier downgrade", () => {
  it("drops a tier after a year with no orders and makes the member re-earn it", async () => {
    await live();
    await earn(71, 6000);
    const m0 = await findMember(SHOP, 71);
    await prisma.member.update({
      where: { id: m0.id },
      data: { lastOrderAt: new Date(Date.now() - 400 * DAY), tierAchievedAt: new Date(Date.now() - 400 * DAY) },
    });
    await prisma.ledgerEntry.updateMany({ where: { memberId: m0.id }, data: { createdAt: new Date(Date.now() - 400 * DAY) } });
    await downgradeInactive(SHOP);
    const m = await findMember(SHOP, 71);
    const silver = await prisma.tier.findFirst({ where: { shop: SHOP, name: "Silver" } });
    expect(m.tierId).toBe(silver.id);
    // First sign-in adds the 100-point welcome bonus, which counts toward the next tier.
    const state = await buildState(SHOP, 71);
    expect(state.member.tier.name).toBe("Silver");
    expect(state.member.nextTier.name).toBe("Gold");
    expect(state.member.nextTier.pointsNeeded).toBe(4900);
  });
});

describe("storefront state", () => {
  it("returns guest info without a customer and member info with one", async () => {
    await live();
    const guest = await buildState(SHOP, null);
    expect(guest.member).toBeNull();
    expect(guest.rewards).toHaveLength(4);
    expect(guest.program.tiers.map((t) => t.name)).toEqual(["Silver", "Gold", "Platinum"]);

    await earn(81, 2600);
    const state = await buildState(SHOP, 81, { cartSubtotal: 3000 });
    expect(state.member.balance).toBe(2700); // 2600 + 100 welcome bonus
    expect(state.member.worthLabel).toBe("₹270");
    expect(state.member.slider.max).toBe(2700);
    expect(state.rewards.find((r) => r.points === 2500).canRedeem).toBe(true);
    expect(state.rewards.find((r) => r.points === 5000).pointsNeeded).toBe(2300);
    expect(state.history[0].label).toBeTruthy();
  });
});
