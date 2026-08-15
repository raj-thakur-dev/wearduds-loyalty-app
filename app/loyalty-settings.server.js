import prisma from "./db.server";

const SETTINGS_ID = "loyalty_settings";

export async function getLoyaltySettings() {
  let settings = await prisma.loyaltySettings.findUnique({
    where: { id: SETTINGS_ID },
  });

  if (!settings) {
    settings = await prisma.loyaltySettings.create({
      data: {
        id: SETTINGS_ID,
        pointsPerRupee: 0.01,
        silverThreshold: 500,
        goldThreshold: 1500,
        redeem500Value: 50,
        redeem1000Value: 120,
        redeem2000Value: 300,
      },
    });
  }

  return settings;
}

export function getTierInfo(points, settings) {
  const TIERS = [
    { name: "Bronze", min: 0 },
    { name: "Silver", min: settings.silverThreshold },
    { name: "Gold", min: settings.goldThreshold },
  ];

  let currentTier = TIERS[0];
  let nextTier = null;

  for (let i = 0; i < TIERS.length; i++) {
    if (points >= TIERS[i].min) {
      currentTier = TIERS[i];
      nextTier = TIERS[i + 1] || null;
    }
  }

  const PERKS = {
    Bronze: ["Earn points per ₹ spent", "Birthday bonus points"],
    Silver: ["Higher earn rate", "Early access to sales", "Birthday bonus points"],
    Gold: ["Highest earn rate", "Free shipping on all orders", "Early access to sales", "Birthday bonus points"],
  };

  if (!nextTier) {
    return {
      tier: currentTier.name,
      perks: PERKS[currentTier.name],
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
    perks: PERKS[currentTier.name],
    progressPercent,
    pointsToNextTier: nextTier.min - points,
    nextTier: nextTier.name,
  };
}

export function getRedeemOptions(settings) {
  return [
    { points: 500, value: `₹${settings.redeem500Value}`, label: `₹${settings.redeem500Value} off`, amount: settings.redeem500Value },
    { points: 1000, value: `₹${settings.redeem1000Value}`, label: `₹${settings.redeem1000Value} off`, amount: settings.redeem1000Value },
    { points: 2000, value: `₹${settings.redeem2000Value}`, label: `₹${settings.redeem2000Value} off`, amount: settings.redeem2000Value },
  ];
}