import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { getSettings } from "./settings.server";
import { computeTierSpend, expireDueCredits, setTier, withMemberLock } from "./ledger.server";
import { pollPendingShipping, releaseDueOrders } from "./orders.server";
import { expireCodes } from "./redeem.server";
import { awardBirthdays } from "./actions.server";
import { addDays, tierForPoints } from "./math";
import { runEffects } from "./effects.server";
import { publishConfig } from "./config.server";

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

/**
 * Flow trigger for members whose coins expire in exactly `expiryWarningDays`,
 * and again at `expirySecondWarningDays` (daily windows).
 */
export async function warnExpiringPoints(shop, now = new Date()) {
  const settings = await getSettings(shop);
  if (settings.expiryDays <= 0) return { warned: 0 };
  const days = [settings.expiryWarningDays, settings.expirySecondWarningDays].filter((d, i, a) => d > 0 && a.indexOf(d) === i);
  let warned = 0;
  for (const d of days) {
    const from = addDays(now, d - 1);
    const to = addDays(now, d);
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
      daysLeft: d,
    }));
    await runEffects(shop, effects);
    warned += rows.length;
  }
  return { warned };
}

/**
 * Daily: recompute each member's ₹ spend in the tier window and move them to
 * the tier it earns (down as well as up). Staff-locked tiers are left alone.
 */
export async function refreshTiers(shop, now = new Date()) {
  const settings = await getSettings(shop);
  const tiers = await prisma.tier.findMany({ where: { shop }, orderBy: { threshold: "asc" } });
  if (tiers.length === 0) return { checked: 0, changed: 0 };
  // Anyone above the entry tier, plus anyone with spend on record or a recent order.
  const recent = addDays(now, -Math.max(settings.downgradeAfterDays, 1));
  const candidates = await prisma.member.findMany({
    where: {
      shop,
      tierLocked: false,
      OR: [{ tierId: { in: tiers.slice(1).map((t) => t.id) } }, { tierSpend: { gt: 0 } }, { lastOrderAt: { gte: recent } }],
    },
    select: { id: true },
    take: 5000,
  });
  const effects = [];
  let changed = 0;
  for (const c of candidates) {
    await withMemberLock(c.id, async (tx, member) => {
      const spend = await computeTierSpend(tx, member, settings.downgradeAfterDays, now);
      if (spend !== member.tierSpend) {
        await tx.member.update({ where: { id: member.id }, data: { tierSpend: spend } });
        member.tierSpend = spend;
      }
      const target = tierForPoints(tiers, spend);
      if (!target || target.id === member.tierId) return;
      const current = tiers.find((t) => t.id === member.tierId);
      const direction = current && target.threshold < current.threshold ? "down" : "up";
      await setTier(tx, member, target, { lock: false, direction }, effects);
      changed++;
    });
  }
  await runEffects(shop, effects);
  return { checked: candidates.length, changed };
}

/** Kept for older imports. */
export const downgradeInactive = refreshTiers;

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
  await step("tiers", () => once(shop, "tiers", () => refreshTiers(shop, now), now));
  // Theme Liquid (product "earn X coins") reads a copy of the settings in a shop
  // metafield. Refresh it daily so changes made outside the admin (migrations,
  // direct DB edits) reach the storefront without someone pressing Save.
  if (admin) await step("config", () => once(shop, "config", async () => { await publishConfig(shop, admin); return { published: true }; }, now));
  return results;
}

export async function runAllShops(now = new Date()) {
  const shops = await prisma.session.findMany({ where: { isOnline: false }, select: { shop: true }, distinct: ["shop"] });
  const out = {};
  for (const { shop } of shops) out[shop] = await runShopJobs(shop, now);
  return out;
}
