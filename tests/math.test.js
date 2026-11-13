import { describe, expect, it } from "vitest";
import {
  birthdayYearDue,
  computeReleaseAt,
  eligibleAmountFromOrder,
  maxSliderPoints,
  minimumSubtotalFor,
  nextTierProgress,
  purchasePoints,
  refundReversal,
  tierForPoints,
  wordCount,
} from "../app/loyalty/math";

const tiers = [
  { id: "s", name: "Silver", threshold: 0 },
  { id: "g", name: "Gold", threshold: 5000 },
  { id: "p", name: "Platinum", threshold: 15000 },
];

describe("purchasePoints", () => {
  it("applies rate and tier multiplier, rounding down", () => {
    expect(purchasePoints(1999, 1, 1)).toBe(1999);
    expect(purchasePoints(1999, 1, 1.25)).toBe(2498);
    expect(purchasePoints(1999, 1, 1.5)).toBe(2998);
    expect(purchasePoints(0, 1, 1)).toBe(0);
    expect(purchasePoints(-5, 1, 1)).toBe(0);
  });
});

describe("eligibleAmountFromOrder", () => {
  it("uses line prices net of discounts and skips gift cards", () => {
    const order = {
      line_items: [
        { price: "1000.00", quantity: 2, discount_allocations: [{ amount: "200.00" }] },
        { price: "500.00", quantity: 1, gift_card: true },
        { price: "300.00", quantity: 1, current_quantity: 0 },
      ],
      shipping_lines: [{ price: "99.00" }],
    };
    expect(eligibleAmountFromOrder(order)).toBe(1800);
  });
  it("falls back to subtotal without lines", () => {
    expect(eligibleAmountFromOrder({ current_subtotal_price: "849.50" })).toBe(849.5);
  });
});

describe("tiers", () => {
  it("picks the highest tier reached", () => {
    expect(tierForPoints(tiers, 0).name).toBe("Silver");
    expect(tierForPoints(tiers, 4999).name).toBe("Silver");
    expect(tierForPoints(tiers, 5000).name).toBe("Gold");
    expect(tierForPoints(tiers, 20000).name).toBe("Platinum");
  });
  it("reports progress to the next tier", () => {
    const p = nextTierProgress(tiers, 2500);
    expect(p.next.name).toBe("Gold");
    expect(p.pointsNeeded).toBe(2500);
    expect(p.progress).toBe(50);
    expect(nextTierProgress(tiers, 16000).next).toBeNull();
  });
});

describe("redemption limits", () => {
  it("derives a minimum subtotal that keeps the reward within the max %", () => {
    expect(minimumSubtotalFor(50, 20, 500)).toBe(500);
    expect(minimumSubtotalFor(100, 20, 800)).toBe(800); // 100 is 12.5% of 800
    expect(minimumSubtotalFor(250, 20, 0)).toBe(1250);
    expect(minimumSubtotalFor(500, 20, 3000)).toBe(3000);
  });
  it("caps the slider at the balance and the % of cart, in steps", () => {
    expect(maxSliderPoints({ balance: 5000, cartSubtotal: 2000, pointValue: 0.1, maxRedeemPercent: 20, step: 100 })).toBe(4000);
    expect(maxSliderPoints({ balance: 1360, cartSubtotal: 10000, pointValue: 0.1, maxRedeemPercent: 20, step: 100 })).toBe(1300);
    expect(maxSliderPoints({ balance: 0, cartSubtotal: 10000, pointValue: 0.1, maxRedeemPercent: 20, step: 100 })).toBe(0);
  });
});

describe("refundReversal", () => {
  it("takes back points in proportion and never double counts", () => {
    expect(refundReversal({ orderPoints: 1000, eligibleAmount: 1000, refundedTotal: 400, alreadyReversed: 0 })).toBe(400);
    expect(refundReversal({ orderPoints: 1000, eligibleAmount: 1000, refundedTotal: 1000, alreadyReversed: 400 })).toBe(600);
    expect(refundReversal({ orderPoints: 1000, eligibleAmount: 1000, refundedTotal: 1500, alreadyReversed: 1000 })).toBe(0);
  });
});

describe("computeReleaseAt", () => {
  const paidAt = new Date("2026-11-01T00:00:00Z");
  const fulfilledAt = new Date("2026-11-02T00:00:00Z");
  const deliveredAt = new Date("2026-11-05T00:00:00Z");
  it("uses delivery + hold days", () => {
    const at = computeReleaseAt({ creditTrigger: "DELIVERED", holdDays: 7, fallbackDays: 15 }, { paidAt, fulfilledAt, deliveredAt });
    expect(at.toISOString()).toBe("2026-11-12T00:00:00.000Z");
  });
  it("falls back to fulfilment + fallback days without delivery", () => {
    const at = computeReleaseAt({ creditTrigger: "DELIVERED", holdDays: 7, fallbackDays: 15 }, { paidAt, fulfilledAt });
    expect(at.toISOString()).toBe("2026-11-17T00:00:00.000Z");
  });
  it("waits when nothing has shipped", () => {
    expect(computeReleaseAt({ creditTrigger: "DELIVERED", holdDays: 7 }, { paidAt })).toBeNull();
  });
});

describe("birthdayYearDue", () => {
  it("fires within the look-ahead window", () => {
    expect(birthdayYearDue({ birthMonth: 11, birthDay: 16 }, 3, new Date("2026-11-13T10:00:00Z"))).toBe(2026);
    expect(birthdayYearDue({ birthMonth: 11, birthDay: 17 }, 3, new Date("2026-11-13T10:00:00Z"))).toBeNull();
    expect(birthdayYearDue({ birthMonth: 1, birthDay: 1 }, 3, new Date("2026-12-30T10:00:00Z"))).toBe(2027);
  });
  it("celebrates Feb 29 on Feb 28 in non-leap years", () => {
    expect(birthdayYearDue({ birthMonth: 2, birthDay: 29 }, 0, new Date("2027-02-28T10:00:00Z"))).toBe(2027);
  });
});

describe("wordCount", () => {
  it("counts words", () => {
    expect(wordCount("  love   this hoodie ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});
