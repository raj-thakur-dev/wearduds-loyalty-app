import crypto from "node:crypto";
import prisma from "../db.server";
import {
  DEFAULT_EARN_RULES,
  DEFAULT_REWARDS,
  DEFAULT_TIERS,
  DEFAULT_WIDGET,
} from "./defaults";

/** Deep-merge stored JSON over defaults so newly added rule keys always exist. */
function mergeDefaults(defaults, stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return structuredClone(defaults);
  const out = structuredClone(defaults);
  for (const [key, value] of Object.entries(stored)) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object") {
      out[key] = { ...out[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function hydrate(row) {
  return {
    ...row,
    earnRules: mergeDefaults(DEFAULT_EARN_RULES, row.earnRules),
    widget: mergeDefaults(DEFAULT_WIDGET, row.widget),
  };
}

/** Settings for a shop, creating the row plus default tiers and rewards on first use. */
export async function getSettings(shop) {
  const existing = await prisma.programSettings.findUnique({ where: { shop } });
  if (existing) return hydrate(existing);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.programSettings.create({
        data: {
          shop,
          earnRules: DEFAULT_EARN_RULES,
          widget: DEFAULT_WIDGET,
          integrationSecret: crypto.randomBytes(24).toString("hex"),
        },
      });
      const tierCount = await tx.tier.count({ where: { shop } });
      if (tierCount === 0) {
        await tx.tier.createMany({
          data: DEFAULT_TIERS.map((t, i) => ({ ...t, shop, sortOrder: i })),
        });
      }
      const rewardCount = await tx.reward.count({ where: { shop } });
      if (rewardCount === 0) {
        await tx.reward.createMany({
          data: DEFAULT_REWARDS.map((r, i) => ({ ...r, shop, sortOrder: i })),
        });
      }
      return row;
    });
    return hydrate(created);
  } catch (err) {
    // Two requests raced to create the row; the other one won.
    if (err?.code === "P2002") {
      return hydrate(await prisma.programSettings.findUniqueOrThrow({ where: { shop } }));
    }
    throw err;
  }
}

export async function getTiers(shop) {
  return prisma.tier.findMany({ where: { shop }, orderBy: { threshold: "asc" } });
}

export async function getActiveRewards(shop) {
  return prisma.reward.findMany({
    where: { shop, active: true },
    orderBy: [{ sortOrder: "asc" }, { pointsCost: "asc" }],
    include: { minTier: true },
  });
}

const NUMERIC_FIELDS = {
  pointsPerCurrency: { min: 0, max: 100, float: true },
  pointValue: { min: 0.001, max: 100, float: true },
  holdDays: { min: 0, max: 90 },
  fallbackDays: { min: 1, max: 120 },
  expiryDays: { min: 0, max: 3650 },
  expiryWarningDays: { min: 1, max: 90 },
  maxRedeemPercent: { min: 1, max: 100 },
  codeExpiryDays: { min: 1, max: 365 },
  sliderStep: { min: 1, max: 100000 },
  sliderMinPoints: { min: 0, max: 1000000 },
  downgradeAfterDays: { min: 0, max: 3650 },
};
const BOOLEAN_FIELDS = [
  "isLive",
  "combinesWithProduct",
  "combinesWithOrder",
  "combinesWithShipping",
  "sliderEnabled",
  "storeCreditEnabled",
  "restorePointsOnCancel",
];

/** Validates a partial settings update. Returns { data } or { errors }. */
export function validateSettingsInput(input) {
  const data = {};
  const errors = {};
  for (const [key, rule] of Object.entries(NUMERIC_FIELDS)) {
    if (input[key] === undefined || input[key] === null || input[key] === "") continue;
    const n = rule.float ? Number.parseFloat(input[key]) : Number.parseInt(input[key], 10);
    if (!Number.isFinite(n) || n < rule.min || n > rule.max) {
      errors[key] = `Enter a number between ${rule.min} and ${rule.max}.`;
    } else {
      data[key] = n;
    }
  }
  for (const key of BOOLEAN_FIELDS) {
    if (input[key] === undefined) continue;
    data[key] = input[key] === true || input[key] === "true" || input[key] === "on";
  }
  if (input.programName !== undefined) {
    const name = String(input.programName).trim();
    if (!name || name.length > 60) errors.programName = "Use 1 to 60 characters.";
    else data.programName = name;
  }
  if (input.codePrefix !== undefined) {
    const prefix = String(input.codePrefix).trim().toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(prefix)) errors.codePrefix = "Use up to 8 letters or numbers.";
    else data.codePrefix = prefix;
  }
  if (input.creditTrigger !== undefined) {
    if (!["PAID", "FULFILLED", "DELIVERED"].includes(input.creditTrigger)) {
      errors.creditTrigger = "Choose when purchase points unlock.";
    } else data.creditTrigger = input.creditTrigger;
  }
  if (input.excludeTags !== undefined) {
    data.excludeTags = String(input.excludeTags)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  return Object.keys(errors).length ? { errors } : { data };
}

const RULE_LIMITS = { points: [0, 100000], daysBefore: [0, 30], minWords: [0, 500], referrerPoints: [0, 100000], friendPoints: [0, 100000], monthlyCap: [0, 1000] };

/** Validates and merges an earn-rules update for one rule key. */
export function validateEarnRule(key, input, current) {
  if (!(key in DEFAULT_EARN_RULES)) return { errors: { key: "Unknown rule." } };
  const next = { ...current[key] };
  const errors = {};
  for (const [field, value] of Object.entries(input)) {
    if (field === "enabled" || field === "requireVerifiedBuyer") {
      next[field] = value === true || value === "true" || value === "on";
    } else if (field === "handle") {
      const handle = String(value).replace(/^@/, "").trim();
      if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) errors.handle = "Enter a valid Instagram handle.";
      else next.handle = handle;
    } else if (field in RULE_LIMITS) {
      const n = Number.parseInt(value, 10);
      const [min, max] = RULE_LIMITS[field];
      if (!Number.isFinite(n) || n < min || n > max) errors[field] = `Enter a number between ${min} and ${max}.`;
      else next[field] = n;
    }
  }
  if (Object.keys(errors).length) return { errors };
  return { data: { ...current, [key]: next } };
}

export async function updateSettings(shop, data) {
  await getSettings(shop);
  const row = await prisma.programSettings.update({ where: { shop }, data });
  return hydrate(row);
}
