import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { emitFlowTrigger, syncCustomer } from "./shopify-api.server";

// Side effects run after a transaction commits: Shopify customer sync and
// Flow triggers. They never throw; a failed sync is retried by the next change
// or by the nightly resync job.

export const FLOW_TRIGGERS = {
  points_earned: "club-points-earned",
  tier_changed: "club-tier-changed",
  reward_redeemed: "club-reward-redeemed",
  points_expiring: "club-points-expiring",
};

async function adminFor(shop, admin) {
  if (admin) return admin;
  try {
    const ctx = await unauthenticated.admin(shop);
    return ctx.admin;
  } catch (err) {
    console.error(`[club] no admin session for ${shop}:`, err.message);
    return null;
  }
}

export async function runEffects(shop, effects, admin = null) {
  if (!effects?.length) return;
  const client = await adminFor(shop, admin);
  if (!client) return;

  const syncIds = [...new Set(effects.filter((e) => e.kind === "sync").map((e) => e.memberId))];
  if (syncIds.length) {
    const [members, tiers] = await Promise.all([
      prisma.member.findMany({ where: { id: { in: syncIds } }, include: { tier: true } }),
      prisma.tier.findMany({ where: { shop }, select: { name: true } }),
    ]);
    const tierNames = tiers.map((t) => t.name);
    await Promise.all(
      members.map((m) =>
        syncCustomer(client, m, m.tier?.name, tierNames).catch((err) =>
          console.error(`[club] sync failed for member ${m.id}:`, err.message),
        ),
      ),
    );
  }

  const flowEffects = effects.filter((e) => FLOW_TRIGGERS[e.kind]);
  if (!flowEffects.length) return;
  const ids = [...new Set(flowEffects.map((e) => e.memberId))];
  const members = await prisma.member.findMany({ where: { id: { in: ids } }, include: { tier: true } });
  const byId = new Map(members.map((m) => [m.id, m]));
  for (const effect of flowEffects) {
    const member = byId.get(effect.memberId);
    if (!member) continue;
    const payload = flowPayload(effect, member);
    await emitFlowTrigger(client, FLOW_TRIGGERS[effect.kind], payload).catch((err) => {
      // Flow returns an error when no workflow uses the trigger yet; that is fine.
      if (!/not.*(enabled|found|subscribed)/i.test(err.message)) {
        console.error(`[club] flow ${effect.kind} failed:`, err.message);
      }
    });
  }
}

function flowPayload(effect, member) {
  const base = {
    customer_id: Number(member.customerId),
    "Points balance": member.balance,
    "Tier": member.tier?.name || "",
  };
  switch (effect.kind) {
    case "points_earned":
      return { ...base, "Points earned": effect.points, "Reason": effect.description || effect.type };
    case "tier_changed":
      return { ...base, "Previous tier": effect.from || "", "New tier": effect.to || "", "Direction": effect.direction };
    case "reward_redeemed":
      return { ...base, "Points spent": effect.points, "Discount code": effect.code || "", "Reward": effect.label || "" };
    case "points_expiring":
      return { ...base, "Points expiring": effect.points, "Expiry date": effect.expiresAt };
    default:
      return base;
  }
}
