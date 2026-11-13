import { getActiveRewards, getSettings, getTiers } from "./settings.server";
import { publishStorefrontConfig } from "./shopify-api.server";

/**
 * Public program config for theme Liquid (`app.metafields.club.config`), so
 * product and cart blocks can show "earn X points" without a network call.
 */
export async function buildPublicConfig(shop) {
  const [settings, tiers, rewards] = await Promise.all([getSettings(shop), getTiers(shop), getActiveRewards(shop)]);
  return {
    name: settings.programName,
    live: settings.isLive,
    currency: settings.currencyCode,
    pointsPerCurrency: settings.pointsPerCurrency,
    pointValue: settings.pointValue,
    maxRedeemPercent: settings.maxRedeemPercent,
    signupPoints: settings.earnRules.signup.enabled ? settings.earnRules.signup.points : 0,
    tiers: tiers.map((t) => ({ name: t.name, threshold: t.threshold, multiplier: t.multiplier })),
    lowestReward: rewards.length ? Math.min(...rewards.map((r) => r.pointsCost)) : null,
    widget: settings.widget,
  };
}

export async function publishConfig(shop, admin) {
  const config = await buildPublicConfig(shop);
  await publishStorefrontConfig(admin, config);
  return config;
}
