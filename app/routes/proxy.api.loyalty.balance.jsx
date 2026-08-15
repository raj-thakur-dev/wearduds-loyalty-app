import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Points thresholds for each tier — adjust these to match your actual program rules
const TIERS = [
  { name: "Bronze", min: 0 },
  { name: "Silver", min: 500 },
  { name: "Gold", min: 1500 },
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
      progressPercent: 100,
      pointsToNextTier: null,
      nextTier: null,
    };
  }

  const pointsIntoTier = points - currentTier.min;
  const pointsNeededForTier = nextTier.min - currentTier.min;
  const progressPercent = Math.min(
    100,
    Math.round((pointsIntoTier / pointsNeededForTier) * 100)
  );

  return {
    tier: currentTier.name,
    progressPercent,
    pointsToNextTier: nextTier.min - points,
    nextTier: nextTier.name,
  };
}

export async function loader({ request }) {
  // Verifies this request genuinely came from Shopify's app proxy
  // (checks the signature Shopify attaches to proxied requests)
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");

  if (!customerId) {
    return Response.json({ error: "Missing customer_id" }, { status: 400 });
  }

  const member = await prisma.loyaltyMember.findUnique({
    where: { shopifyCustomerId: String(customerId) },
  });

  if (!member) {
    // Customer has no loyalty record yet — return zero-state instead of an error
    return Response.json({
      points: 0,
      ...getTierInfo(0),
    });
  }

  const tierInfo = getTierInfo(member.points);

  return Response.json({
    points: member.points,
    ...tierInfo,
  });
}