import prisma from "../db.server";
import { randomCode } from "./math";

export function customerIdFromGid(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value);
  const m = s.match(/(\d+)$/);
  return m ? m[1] : null;
}

export function customerGid(customerId) {
  return `gid://shopify/Customer/${customerId}`;
}

function referralCodeFor(firstName) {
  const base = String(firstName || "")
    .normalize("NFKD")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase()
    .slice(0, 8);
  return `${base || "CLUB"}-${randomCode(4)}`;
}

function profileData(profile = {}) {
  const data = {};
  if (profile.email) data.email = String(profile.email).toLowerCase().slice(0, 254);
  if (profile.firstName) data.firstName = String(profile.firstName).slice(0, 80);
  if (profile.lastName) data.lastName = String(profile.lastName).slice(0, 80);
  if (Number.isFinite(profile.ordersCount)) data.ordersCount = profile.ordersCount;
  if (Number.isFinite(profile.totalSpent)) data.totalSpent = profile.totalSpent;
  return data;
}

/**
 * Finds or creates the member for a Shopify customer. Safe under concurrency:
 * a unique violation from a parallel insert falls back to reading the winner.
 */
export async function ensureMember(shop, customerId, profile = {}) {
  const id = customerIdFromGid(customerId);
  if (!id) throw new Error("ensureMember: missing customer id");

  const existing = await prisma.member.findUnique({ where: { shop_customerId: { shop, customerId: id } } });
  if (existing) {
    const data = profileData(profile);
    const changed = Object.entries(data).some(([k, v]) => existing[k] !== v);
    return changed ? prisma.member.update({ where: { id: existing.id }, data }) : existing;
  }

  const entryTier = await prisma.tier.findFirst({ where: { shop }, orderBy: { threshold: "asc" } });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.member.create({
        data: {
          shop,
          customerId: id,
          referralCode: referralCodeFor(profile.firstName),
          tierId: entryTier?.id ?? null,
          ...profileData(profile),
        },
      });
    } catch (err) {
      if (err?.code !== "P2002") throw err;
      const raced = await prisma.member.findUnique({ where: { shop_customerId: { shop, customerId: id } } });
      if (raced) return raced;
      // Otherwise the referral code collided; loop and try a new one.
    }
  }
  throw new Error("Could not allocate a referral code");
}

export async function findMember(shop, customerId) {
  const id = customerIdFromGid(customerId);
  if (!id) return null;
  return prisma.member.findUnique({ where: { shop_customerId: { shop, customerId: id } } });
}

export function isExcludedByTags(settings, tags) {
  if (!settings.excludeTags?.length) return false;
  const list = Array.isArray(tags)
    ? tags
    : String(tags || "")
        .split(",")
        .map((t) => t.trim());
  const lower = new Set(list.map((t) => t.toLowerCase()));
  return settings.excludeTags.some((t) => lower.has(t.toLowerCase()));
}
