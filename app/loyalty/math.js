// Pure, dependency-free point calculations. Shared by the server and covered by unit tests.

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * DAY_MS);
}

/**
 * When pending purchase points unlock, given the shop's trigger.
 * DELIVERED falls back to fulfilment + fallbackDays when the courier never
 * reports delivery to Shopify.
 */
export function computeReleaseAt(settings, { paidAt, fulfilledAt, deliveredAt }) {
  const hold = Number(settings.holdDays || 0);
  switch (settings.creditTrigger) {
    case "PAID":
      return paidAt ? addDays(paidAt, hold) : null;
    case "FULFILLED":
      return fulfilledAt ? addDays(fulfilledAt, hold) : null;
    case "DELIVERED":
    default:
      if (deliveredAt) return addDays(deliveredAt, hold);
      if (fulfilledAt) return addDays(fulfilledAt, Number(settings.fallbackDays || 15));
      return null;
  }
}

export function roundMoney(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/** Points for an order: eligible spend × rate × tier multiplier, rounded down. */
export function purchasePoints(eligibleAmount, pointsPerCurrency, multiplier = 1) {
  const amount = Number(eligibleAmount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.floor(amount * Number(pointsPerCurrency) * Number(multiplier || 1));
}

/**
 * Amount of an order that earns points: line items after discounts, excluding
 * gift cards, shipping and tips. Works on the REST-style webhook payload.
 */
export function eligibleAmountFromOrder(order) {
  const lines = Array.isArray(order?.line_items) ? order.line_items : [];
  if (lines.length === 0) {
    return Math.max(0, roundMoney(order?.current_subtotal_price ?? order?.subtotal_price ?? 0));
  }
  let total = 0;
  for (const line of lines) {
    if (line.gift_card) continue;
    const qty = Number(line.current_quantity ?? line.quantity ?? 0);
    if (qty <= 0) continue;
    const gross = Number(line.price || 0) * qty;
    const discounts = (line.discount_allocations || []).reduce(
      (sum, d) => sum + Number(d.amount || 0),
      0,
    );
    total += Math.max(0, gross - discounts);
  }
  // Order-level discounts (e.g. a loyalty ₹ off code) are spread as
  // discount_allocations on lines, so `total` is already net of them.
  return Math.max(0, roundMoney(total));
}

/** Tiers sorted ascending by threshold; returns the highest tier reached. */
export function tierForPoints(tiers, lifetimePoints) {
  const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold);
  let current = sorted[0] || null;
  for (const tier of sorted) {
    if (lifetimePoints >= tier.threshold) current = tier;
  }
  return current;
}

export function nextTierProgress(tiers, lifetimePoints) {
  const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold);
  const current = tierForPoints(sorted, lifetimePoints);
  const idx = current ? sorted.findIndex((t) => t.id === current.id || t.name === current.name) : -1;
  const next = idx >= 0 ? sorted[idx + 1] : sorted[0];
  if (!next) return { current, next: null, pointsNeeded: 0, progress: 100 };
  const base = current ? current.threshold : 0;
  const span = Math.max(1, next.threshold - base);
  const progress = Math.max(0, Math.min(100, Math.floor(((lifetimePoints - base) / span) * 100)));
  return { current, next, pointsNeeded: Math.max(0, next.threshold - lifetimePoints), progress };
}

export function rankOf(tiers, tier) {
  if (!tier) return -1;
  const sorted = [...tiers].sort((a, b) => a.threshold - b.threshold);
  return sorted.findIndex((t) => t.id === tier.id);
}

/** Rupee value of a number of points. */
export function pointsToMoney(points, pointValue) {
  return roundMoney(Number(points || 0) * Number(pointValue));
}

/**
 * Minimum cart subtotal for a reward so that the reward never exceeds
 * `maxRedeemPercent` of the order. An explicit tile minimum wins if higher.
 */
export function minimumSubtotalFor(amount, maxRedeemPercent, explicitMinimum) {
  const pct = Math.max(1, Math.min(100, Number(maxRedeemPercent) || 100));
  const derived = Math.ceil((Number(amount) * 100) / pct);
  const explicit = Number(explicitMinimum || 0);
  return Math.max(derived, explicit);
}

/** Largest slider redemption allowed for a cart, in points. */
export function maxSliderPoints({ balance, cartSubtotal, pointValue, maxRedeemPercent, step }) {
  const capMoney = (Number(cartSubtotal || 0) * Number(maxRedeemPercent)) / 100;
  const capPoints = Math.floor(capMoney / Number(pointValue));
  const raw = Math.min(Number(balance || 0), capPoints);
  const s = Math.max(1, Number(step) || 1);
  return Math.max(0, Math.floor(raw / s) * s);
}

/**
 * Points to take back for a refund, proportional to the refunded share of the
 * eligible amount. Returns only the delta beyond what was already reversed.
 */
export function refundReversal({ orderPoints, eligibleAmount, refundedTotal, alreadyReversed }) {
  if (!eligibleAmount || eligibleAmount <= 0) return 0;
  const share = Math.min(1, Math.max(0, refundedTotal / eligibleAmount));
  const target = Math.round(orderPoints * share);
  return Math.max(0, Math.min(orderPoints, target) - (alreadyReversed || 0));
}

/** Is today within `daysBefore` days of the member's next birthday? Returns the year awarded. */
export function birthdayYearDue({ birthMonth, birthDay }, daysBefore, now = new Date()) {
  if (!birthMonth || !birthDay) return null;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (const year of [today.getUTCFullYear(), today.getUTCFullYear() + 1]) {
    // Feb 29 birthdays are celebrated on Feb 28 in non-leap years.
    let day = birthDay;
    if (birthMonth === 2 && birthDay === 29 && !isLeap(year)) day = 28;
    const bday = new Date(Date.UTC(year, birthMonth - 1, day));
    const diff = Math.round((bday - today) / DAY_MS);
    if (diff >= 0 && diff <= daysBefore) return year;
  }
  return null;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function wordCount(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function randomCode(length = 6, rand = Math.random) {
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return out;
}

export function formatPoints(n) {
  return Number(n || 0).toLocaleString("en-IN");
}

export function formatMoney(n, currency = "INR") {
  const value = roundMoney(n);
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    }).format(value);
  } catch {
    return `₹${value}`;
  }
}
