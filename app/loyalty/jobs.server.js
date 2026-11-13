import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { getSettings } from "./settings.server";
import { expireDueCredits, setTier, tierPoints, withMemberLock } from "./ledger.server";
import { pollPendingShipping, releaseDueOrders } from "./orders.server";
import { expireCodes } from "./redeem.server";
import { awardBirthdays } from "./actions.server";
import { addDays, tierForPoints } from "./math";
import { runEffects } from "./effects.server";

/** Runs a job at most once per UTC day per shop. */
async function once(shop, kind, fn, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const marker = `${kind}:${day}`;
  const done = await prisma.jobRun.findFirst({ where: { shop, kind: marker, status: "DONE" } });
  if (done) return { skipped: "already_ran_today" };
  const run = await prisma.jobRun.create({ data: { shop, kind: marker } });
  try {
    const result = await fn();
    await prisma.jobRun.update({ where: { id: run.id }, data: { status: "DONE", result, finishedAt: new Date() } });
    return result;
  } catch (err) {
    await prisma.jobRun.update({ where: { id: run.id }, data: { status: "FAILED", error: String(err.message).slice(0, 500), finishedAt: new Date() } });
    throw err;
  }
}

export async function expirePoints(shop, now = new Date()) {
  const due = await prisma.ledgerEntry.findMany({
    where: { shop, status: "AVAILABLE", remaining: { gt: 0 }, expiresAt: { lte: now } },
    select: { memberId: true },
    distinct: ["memberId"],
    take: 1000,
  });
  const effects = [];
  let points = 0;
  for (const { memberId } of due) {
    const r = await withMemberLock(memberId, (tx, member) => expireDueCredits(tx, member, now, effects));
    points += r.expired;
  }
  await runEffects(shop, effects);
  return { members: due.length, points };
}

/** Flow trigger for members whose points expire in exactly `expiryWarningDays` (daily window). */
export async function warnExpiringPoints(shop, now = new Date()) {
  const settings = await getSettings(shop);
  if (settings.expiryDays <= 0) return { warned: 0 };
  const from = addDays(now, settings.expiryWarningDays - 1);
  const to = addDays(now, settings.expiryWarningDays);
  const rows = await prisma.ledgerEntry.groupBy({
    by: ["memberId"],
    where: { shop, status: "AVAILABLE", remaining: { gt: 0 }, expiresAt: { gt: from, lte: to } },
    _sum: { remaining: true },
    _min: { expiresAt: true },
  });
  const effects = rows.map((r) => ({
    kind: "points_expiring",
    memberId: r.memberId,
    points: r._sum.remaining,
    expiresAt: r._min.expiresAt?.toISOString().slice(0, 10),
  }));
  await runEffects(shop, effects);
  return { warned: rows.length };
}

/** Drops a tier for members with no order in `downgradeAfterDays`, recalculated on the window's points. */
export async function downgradeInactive(shop, now = new Date()) {
  const settings = await getSettings(shop);
  if (settings.downgradeAfterDays <= 0) return { downgraded: 0 };
  const tiers = await prisma.tier.findMany({ where: { shop }, orderBy: { threshold: "asc" } });
  if (tiers.length < 2) return { downgraded: 0 };
  const cutoff = addDays(now, -settings.downgradeAfterDays);
  const candidates = await prisma.member.findMany({
    where: {
      shop,
      tierLocked: false,
      tierId: { in: tiers.slice(1).map((t) => t.id) },
      tierAchievedAt: { lte: cutoff },
      OR: [{ lastOrderAt: null }, { lastOrderAt: { lte: cutoff } }],
    },
    take: 500,
  });
  const effects = [];
  let downgraded = 0;
  for (const c of candidates) {
    await withMemberLock(c.id, async (tx, member) => {
      const recent = await tx.ledgerEntry.aggregate({
        where: { memberId: member.id, points: { gt: 0 }, status: "AVAILABLE", createdAt: { gte: cutoff }, type: { not: "REDEMPTION_RESTORED" } },
        _sum: { points: true },
      });
      const windowPoints = recent._sum.points || 0;
      const target = tierForPoints(tiers, windowPoints);
      const current = tiers.find((t) => t.id === member.tierId);
      if (!target || !current || target.threshold >= current.threshold) return;
      // Re-base tier progress so the member has to re-earn the gap from here.
      const offset = Math.max(0, member.lifetimeEarned - Math.max(windowPoints, target.threshold));
      await tx.member.update({ where: { id: member.id }, data: { tierPointsOffset: offset } });
      member.tierPointsOffset = offset;
      if (tierForPoints(tiers, tierPoints(member)).id !== target.id) return;
      await setTier(tx, member, target, { lock: false, direction: "down" }, effects);
      downgraded++;
    });
  }
  await runEffects(shop, effects);
  return { downgraded };
}

/** Everything the hourly cron does for one shop. */
export async function runShopJobs(shop, now = new Date()) {
  const results = {};
  const step = async (name, fn) => {
    try {
      results[name] = await fn();
    } catch (err) {
      console.error(`[club] job ${name} failed for ${shop}:`, err);
      results[name] = { error: err.message };
    }
  };

  let admin = null;
  try {
    admin = (await unauthenticated.admin(shop)).admin;
  } catch (err) {
    results.admin = { error: err.message };
  }

  if (admin) await step("pollShipping", () => pollPendingShipping(shop, admin, now));
  await step("release", () => releaseDueOrders(shop, now));
  await step("expireCodes", () => expireCodes(shop, now));
  await step("expirePoints", () => expirePoints(shop, now));
  await step("birthdays", () => once(shop, "birthdays", () => awardBirthdays(shop, now), now));
  await step("expiryWarnings", () => once(shop, "expiry-warn", () => warnExpiringPoints(shop, now), now));
  await step("downgrades", () => once(shop, "downgrades", () => downgradeInactive(shop, now), now));
  return results;
}

export async function runAllShops(now = new Date()) {
  const shops = await prisma.session.findMany({ where: { isOnline: false }, select: { shop: true }, distinct: ["shop"] });
  const out = {};
  for (const { shop } of shops) out[shop] = await runShopJobs(shop, now);
  return out;
}
