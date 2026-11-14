import prisma from "../db.server";
import { addDays, netSpend, rankOf, tierForPoints } from "./math";
import { LEDGER_LABELS } from "./defaults";

// Invariant kept by every function here:
//   member.balance === SUM(remaining) of the member's AVAILABLE credit entries.

export class LoyaltyError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const NON_TIER_TYPES = new Set(["REDEMPTION_RESTORED"]);

/** Legacy points-based tier score. Tiers now use ₹ spend; kept for old callers. */
export function tierPoints(member) {
  return Math.max(0, member.lifetimeEarned - (member.tierPointsOffset || 0));
}

/**
 * ₹ net spend that counts toward tiers: orders whose coins have unlocked (so
 * the return window has passed), paid inside the tier window, minus refunds.
 * `windowDays` 0 counts every order ever.
 */
export async function computeTierSpend(tx, member, windowDays, now = new Date()) {
  const where = { memberId: member.id, status: "CREDITED" };
  if (windowDays > 0) where.paidAt = { gte: addDays(now, -windowDays) };
  const orders = await tx.loyaltyOrder.findMany({ where, select: { eligibleAmount: true, refundedAmount: true } });
  return netSpend(orders);
}

async function tierWindowDays(tx, shop) {
  const row = await tx.programSettings.findUnique({ where: { shop }, select: { downgradeAfterDays: true } });
  return row ? row.downgradeAfterDays : 365;
}

/**
 * Runs `fn` in a transaction holding a row lock on the member, so balance
 * changes for one member are strictly serialised.
 */
export async function withMemberLock(memberId, fn) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Member" WHERE id = ${memberId} FOR UPDATE`;
      const member = await tx.member.findUniqueOrThrow({ where: { id: memberId } });
      return fn(tx, member);
    },
    { timeout: 20000, maxWait: 10000 },
  );
}

async function existingEntry(tx, shop, idempotencyKey) {
  return tx.ledgerEntry.findUnique({
    where: { shop_idempotencyKey: { shop, idempotencyKey } },
  });
}

/**
 * Adds points. `status: "PENDING"` parks them until release (purchases);
 * otherwise they are spendable now. Idempotent on `key`.
 * Pushes side effects (Flow triggers, sync) into `effects`.
 */
export async function creditPoints(tx, member, settings, opts, effects = []) {
  const {
    points,
    type,
    key,
    description,
    createdBy = "system",
    orderId = null,
    meta = undefined,
    status = "AVAILABLE",
  } = opts;
  const amount = Math.floor(Number(points));
  if (!Number.isFinite(amount) || amount <= 0) return { entry: null, skipped: "zero" };
  if (member.excluded && createdBy === "system") return { entry: null, skipped: "excluded" };

  const dupe = await existingEntry(tx, member.shop, key);
  if (dupe) return { entry: dupe, duplicate: true };

  const now = new Date();
  const available = status === "AVAILABLE";
  const entry = await tx.ledgerEntry.create({
    data: {
      shop: member.shop,
      memberId: member.id,
      points: amount,
      type,
      status,
      remaining: available ? amount : 0,
      availableAt: available ? now : null,
      expiresAt: available && settings.expiryDays > 0 ? addDays(now, settings.expiryDays) : null,
      orderId,
      description: description || LEDGER_LABELS[type] || type,
      idempotencyKey: key,
      createdBy,
      meta,
    },
  });

  const countsForTier = available && !NON_TIER_TYPES.has(type);
  const updated = await tx.member.update({
    where: { id: member.id },
    data: available
      ? {
          balance: { increment: amount },
          lifetimeEarned: countsForTier ? { increment: amount } : undefined,
        }
      : { pending: { increment: amount } },
  });
  Object.assign(member, updated);

  if (available) {
    effects.push({ kind: "points_earned", memberId: member.id, points: amount, type, description: entry.description });
    if (countsForTier && type === "PURCHASE") await evaluateTier(tx, member, effects);
  }
  effects.push({ kind: "sync", memberId: member.id });
  return { entry };
}

/**
 * Takes points, oldest-expiring first. Throws INSUFFICIENT_POINTS unless
 * `allowPartial`, in which case it takes what is there and records the shortfall.
 */
export async function debitPoints(tx, member, opts, effects = []) {
  const { points, type, key, description, createdBy = "system", orderId = null, meta = {}, allowPartial = false } = opts;
  const wanted = Math.floor(Number(points));
  if (!Number.isFinite(wanted) || wanted <= 0) return { entry: null, skipped: "zero" };

  const dupe = await existingEntry(tx, member.shop, key);
  if (dupe) return { entry: dupe, duplicate: true };

  if (member.balance < wanted && !allowPartial) {
    throw new LoyaltyError("INSUFFICIENT_POINTS", "You don't have enough coins for that.");
  }
  const take = Math.min(wanted, Math.max(0, member.balance));

  const allocations = [];
  if (take > 0) {
    const credits = await tx.ledgerEntry.findMany({
      where: { memberId: member.id, status: "AVAILABLE", remaining: { gt: 0 } },
      orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    });
    let left = take;
    for (const credit of credits) {
      if (left <= 0) break;
      const use = Math.min(credit.remaining, left);
      await tx.ledgerEntry.update({ where: { id: credit.id }, data: { remaining: { decrement: use } } });
      allocations.push({ id: credit.id, n: use });
      left -= use;
    }
  }

  const entry = await tx.ledgerEntry.create({
    data: {
      shop: member.shop,
      memberId: member.id,
      points: -take,
      type,
      status: "AVAILABLE",
      remaining: 0,
      availableAt: new Date(),
      orderId,
      description: description || LEDGER_LABELS[type] || type,
      idempotencyKey: key,
      createdBy,
      meta: { ...meta, allocations, ...(take < wanted ? { shortfall: wanted - take } : {}) },
    },
  });

  const updated = await tx.member.update({
    where: { id: member.id },
    data: {
      balance: { decrement: take },
      lifetimeSpent: type === "REDEMPTION" ? { increment: take } : undefined,
    },
  });
  Object.assign(member, updated);
  effects.push({ kind: "sync", memberId: member.id });
  return { entry, taken: take };
}

/** Puts the exact points a debit consumed back onto the credits they came from. */
export async function restoreDebit(tx, member, debitEntry, opts, effects = []) {
  const { key, description = LEDGER_LABELS.REDEMPTION_RESTORED, createdBy = "system" } = opts;
  const dupe = await existingEntry(tx, member.shop, key);
  if (dupe) return { entry: dupe, duplicate: true };

  const allocations = debitEntry.meta?.allocations || [];
  const now = new Date();
  let restored = 0;
  for (const alloc of allocations) {
    const credit = await tx.ledgerEntry.findUnique({ where: { id: alloc.id } });
    if (!credit || credit.status !== "AVAILABLE") continue;
    // If the original credit has expired meanwhile, its points are not revived.
    if (credit.expiresAt && credit.expiresAt <= now) continue;
    await tx.ledgerEntry.update({ where: { id: credit.id }, data: { remaining: { increment: alloc.n } } });
    restored += alloc.n;
  }
  const entry = await tx.ledgerEntry.create({
    data: {
      shop: member.shop,
      memberId: member.id,
      points: restored,
      type: "REDEMPTION_RESTORED",
      status: "AVAILABLE",
      remaining: 0,
      availableAt: now,
      description,
      idempotencyKey: key,
      createdBy,
      meta: { restoredFrom: debitEntry.id },
    },
  });
  if (restored > 0) {
    const updated = await tx.member.update({
      where: { id: member.id },
      data: {
        balance: { increment: restored },
        lifetimeSpent: debitEntry.type === "REDEMPTION" ? { decrement: restored } : undefined,
      },
    });
    Object.assign(member, updated);
  }
  effects.push({ kind: "sync", memberId: member.id });
  return { entry, restored };
}

/**
 * Refreshes the member's ₹ tier spend and moves them up if it now reaches a
 * higher tier. Downgrades run in the daily job so a refund never drops a tier mid-order.
 */
export async function evaluateTier(tx, member, effects = []) {
  const spend = await computeTierSpend(tx, member, await tierWindowDays(tx, member.shop));
  if (spend !== member.tierSpend) {
    const updated = await tx.member.update({ where: { id: member.id }, data: { tierSpend: spend } });
    Object.assign(member, updated);
  }
  if (member.tierLocked) return { changed: false };
  const tiers = await tx.tier.findMany({ where: { shop: member.shop }, orderBy: { threshold: "asc" } });
  if (tiers.length === 0) return { changed: false };
  const target = tierForPoints(tiers, spend);
  const current = tiers.find((t) => t.id === member.tierId) || null;
  if (current && rankOf(tiers, target) <= rankOf(tiers, current)) return { changed: false };
  if (!target || target.id === member.tierId) return { changed: false };

  const updated = await tx.member.update({
    where: { id: member.id },
    data: { tierId: target.id, tierAchievedAt: new Date() },
  });
  Object.assign(member, updated);
  // Joining the entry tier is not an upgrade worth celebrating.
  if (current || rankOf(tiers, target) > 0) {
    effects.push({ kind: "tier_changed", memberId: member.id, from: current?.name || null, to: target.name, direction: "up" });
  }
  return { changed: true, from: current, to: target };
}

/** Sets a tier directly (staff override or downgrade job). */
export async function setTier(tx, member, tier, { lock = false, direction = "down" } = {}, effects = []) {
  const previous = member.tierId ? await tx.tier.findUnique({ where: { id: member.tierId } }) : null;
  const updated = await tx.member.update({
    where: { id: member.id },
    data: { tierId: tier?.id ?? null, tierLocked: lock, tierAchievedAt: new Date() },
  });
  Object.assign(member, updated);
  if (previous?.id !== tier?.id) {
    effects.push({ kind: "tier_changed", memberId: member.id, from: previous?.name || null, to: tier?.name || null, direction });
  }
  effects.push({ kind: "sync", memberId: member.id });
}

/** Unlocks a PENDING purchase entry (and any remaining on it after refunds). */
export async function releasePending(tx, member, settings, entry, effects = []) {
  if (entry.status !== "PENDING") return { released: 0 };
  const now = new Date();
  const amount = Math.max(0, entry.points);
  await tx.ledgerEntry.update({
    where: { id: entry.id },
    data: {
      status: amount > 0 ? "AVAILABLE" : "CANCELLED",
      remaining: amount,
      availableAt: now,
      expiresAt: settings.expiryDays > 0 ? addDays(now, settings.expiryDays) : null,
    },
  });
  const updated = await tx.member.update({
    where: { id: member.id },
    data: {
      pending: { decrement: amount },
      balance: { increment: amount },
      lifetimeEarned: { increment: amount },
    },
  });
  Object.assign(member, updated);
  if (amount > 0) {
    effects.push({ kind: "points_earned", memberId: member.id, points: amount, type: entry.type, description: entry.description });
    await evaluateTier(tx, member, effects);
  }
  effects.push({ kind: "sync", memberId: member.id });
  return { released: amount };
}

/** Reduces or cancels a PENDING entry (refund or cancel before points unlocked). */
export async function shrinkPending(tx, member, entry, by, effects = []) {
  if (entry.status !== "PENDING") return { reduced: 0 };
  const reduce = Math.min(entry.points, Math.max(0, Math.floor(by)));
  const left = entry.points - reduce;
  await tx.ledgerEntry.update({
    where: { id: entry.id },
    data: { points: left, status: left > 0 ? "PENDING" : "CANCELLED" },
  });
  const updated = await tx.member.update({ where: { id: member.id }, data: { pending: { decrement: reduce } } });
  Object.assign(member, updated);
  effects.push({ kind: "sync", memberId: member.id });
  return { reduced: reduce };
}

/** Expires a member's credits whose expiry date has passed. */
export async function expireDueCredits(tx, member, now = new Date(), effects = []) {
  const due = await tx.ledgerEntry.findMany({
    where: { memberId: member.id, status: "AVAILABLE", remaining: { gt: 0 }, expiresAt: { lte: now } },
  });
  const total = due.reduce((s, e) => s + e.remaining, 0);
  if (total <= 0) return { expired: 0 };
  for (const e of due) {
    await tx.ledgerEntry.update({ where: { id: e.id }, data: { remaining: 0 } });
  }
  const take = Math.min(total, Math.max(0, member.balance));
  await tx.ledgerEntry.create({
    data: {
      shop: member.shop,
      memberId: member.id,
      points: -take,
      type: "EXPIRY",
      status: "AVAILABLE",
      remaining: 0,
      availableAt: now,
      description: `${take.toLocaleString("en-IN")} ${take === 1 ? "coin" : "coins"} expired`,
      idempotencyKey: `expiry:${member.id}:${now.toISOString()}`,
      meta: { entries: due.map((e) => ({ id: e.id, n: e.remaining })) },
    },
  });
  const updated = await tx.member.update({ where: { id: member.id }, data: { balance: { decrement: take } } });
  Object.assign(member, updated);
  effects.push({ kind: "sync", memberId: member.id });
  return { expired: take };
}
