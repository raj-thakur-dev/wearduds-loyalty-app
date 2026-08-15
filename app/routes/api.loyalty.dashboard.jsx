import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const TIERS = [
  { name: "Bronze", min: 0, perks: ["Earn 1 point per ₹100 spent", "Birthday bonus points"] },
  { name: "Silver", min: 500, perks: ["Earn 1.25 points per ₹100 spent", "Early access to sales", "Birthday bonus points"] },
  { name: "Gold", min: 1500, perks: ["Earn 1.5 points per ₹100 spent", "Free shipping on all orders", "Early access to sales", "Birthday bonus points"] },
];

const REDEEM_OPTIONS = [
  { points: 500, value: "₹50", label: "₹50 off" },
  { points: 1000, value: "₹120", label: "₹120 off" },
  { points: 2000, value: "₹300", label: "₹300 off" },
];

function getTierInfo(points) {
  let currentTier = TIERS[0];
  let nextTier = null;

  for (let i = 0; i < TIERS.length; i++) {
    if (points >= TIERS[i].min) {
      currentTier = TIERS[i];
      nextTier = TIERS[i + 1] || null;
    }
  }

  if (!nextTier) {
    return {
      tier: currentTier.name,
      perks: currentTier.perks,
      progressPercent: 100,
      pointsToNextTier: null,
      nextTier: null,
    };
  }

  const pointsIntoTier = points - currentTier.min;
  const pointsNeededForTier = nextTier.min - currentTier.min;
  const progressPercent = Math.min(100, Math.round((pointsIntoTier / pointsNeededForTier) * 100));

  return {
    tier: currentTier.name,
    perks: currentTier.perks,
    progressPercent,
    pointsToNextTier: nextTier.min - points,
    nextTier: nextTier.name,
  };
}

export async function loader({ request }) {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");

  if (!customerId) {
    return Response.json({ error: "Missing customer_id" }, { status: 400 });
  }

  const member = await prisma.loyaltyMember.findUnique({
    where: { shopifyCustomerId: String(customerId) },
  });

  const points = member?.points || 0;
  const tierInfo = getTierInfo(points);

  const transactions = await prisma.loyaltyTransaction.findMany({
    where: { shopifyCustomerId: String(customerId) },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const activeCodes = await prisma.redeemedCode.findMany({
    where: {
      shopifyCustomerId: String(customerId),
      used: false,
    },
    orderBy: { createdAt: "desc" },
  });

  return Response.json({
    points,
    ...tierInfo,
    redeemOptions: REDEEM_OPTIONS.map((opt) => ({
      ...opt,
      canRedeem: points >= opt.points,
    })),
    transactions: transactions.map((t) => ({
      id: t.id,
      description: t.description,
      points: t.points,
      date: t.createdAt,
    })),
    activeCodes: activeCodes.map((c) => ({
      id: c.id,
      code: c.discountCode,
      value: c.discountValue,
      expiresAt: c.expiresAt,
    })),
  });
}