import prisma from "../db.server";

// Setup signals: each surface reports in when real traffic reaches it, so the
// admin checklist ticks itself (embed on, Club page added, customer accounts,
// Judge.me / Flow connected) without extra Shopify scopes.
export const SIGNAL_KEYS = ["embed", "page", "account", "thankyou", "judgeme", "flow"];
const THROTTLE_MS = 10 * 60 * 1000;
const seen = new Map();

export async function recordSignals(shop, keys) {
  const now = Date.now();
  const due = [...new Set(keys)].filter((k) => {
    if (!SIGNAL_KEYS.includes(k)) return false;
    const last = seen.get(`${shop}:${k}`) || 0;
    return now - last > THROTTLE_MS;
  });
  if (!due.length) return;
  due.forEach((k) => seen.set(`${shop}:${k}`, now));
  const patch = JSON.stringify(Object.fromEntries(due.map((k) => [k, new Date(now).toISOString()])));
  try {
    await prisma.$executeRaw`UPDATE "ProgramSettings" SET "signals" = "signals" || ${patch}::jsonb WHERE "shop" = ${shop}`;
  } catch (err) {
    due.forEach((k) => seen.delete(`${shop}:${k}`));
    console.error("[club] signal write failed", err.message);
  }
}

/** Fire-and-forget: never let a status ping slow down or break a request. */
export function noteSignals(shop, keys) {
  if (!shop || !keys?.length) return;
  recordSignals(shop, keys).catch(() => {});
}

/** Parses the storefront's `sf` query param (e.g. "e,p") into signal keys. */
export function storefrontSignals(param) {
  const map = { e: "embed", p: "page" };
  return String(param || "")
    .split(",")
    .map((s) => map[s.trim()])
    .filter(Boolean);
}

export function isRecent(iso, days = 30) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && Date.now() - t < days * 86400000;
}
