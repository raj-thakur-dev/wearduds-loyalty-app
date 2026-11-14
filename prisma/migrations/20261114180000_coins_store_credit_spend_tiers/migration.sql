-- Coins (1 coin = ₹1, 3% back), redemption as Shopify store credit with a minimum
-- cart, 90-day expiry with two reminders, and tiers on ₹ spend in the last 12 months.

-- New enum value (not used inside this migration).
ALTER TYPE "LedgerType" ADD VALUE IF NOT EXISTS 'STREAK';

-- New columns and new defaults.
ALTER TABLE "ProgramSettings" ADD COLUMN "expirySecondWarningDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "ProgramSettings" ADD COLUMN "minRedeemSubtotal" DOUBLE PRECISION NOT NULL DEFAULT 1499;
ALTER TABLE "ProgramSettings" ALTER COLUMN "pointsPerCurrency" SET DEFAULT 0.03;
ALTER TABLE "ProgramSettings" ALTER COLUMN "pointValue" SET DEFAULT 1;
ALTER TABLE "ProgramSettings" ALTER COLUMN "expiryDays" SET DEFAULT 90;
ALTER TABLE "ProgramSettings" ALTER COLUMN "sliderStep" SET DEFAULT 1;
ALTER TABLE "ProgramSettings" ALTER COLUMN "sliderMinPoints" SET DEFAULT 10;
ALTER TABLE "ProgramSettings" ALTER COLUMN "storeCreditEnabled" SET DEFAULT true;
ALTER TABLE "Member" ADD COLUMN "tierSpend" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Convert existing shops from points to coins, keeping every balance's ₹ value:
-- coins = points × old point value (e.g. 100 points at ₹0.10 = 10 coins).
CREATE TEMP TABLE "_coin_factor" AS
  SELECT "shop", "pointValue" AS f FROM "ProgramSettings" WHERE "pointValue" <> 1;

UPDATE "LedgerEntry" l SET
  "points" = TRUNC(l."points" * c.f)::int,
  "remaining" = TRUNC(l."remaining" * c.f)::int
FROM "_coin_factor" c WHERE l."shop" = c."shop";

UPDATE "LoyaltyOrder" o SET
  "points" = TRUNC(o."points" * c.f)::int,
  "pointsReversed" = TRUNC(o."pointsReversed" * c.f)::int
FROM "_coin_factor" c WHERE o."shop" = c."shop";

UPDATE "Redemption" r SET "points" = TRUNC(r."points" * c.f)::int
FROM "_coin_factor" c WHERE r."shop" = c."shop";

UPDATE "Reward" r SET "pointsCost" = GREATEST(1, TRUNC(r."pointsCost" * c.f)::int)
FROM "_coin_factor" c WHERE r."shop" = c."shop";

-- Balances are rebuilt from the ledger so they still equal the sum of open credits.
UPDATE "Member" m SET
  "balance" = COALESCE((SELECT SUM(l."remaining") FROM "LedgerEntry" l
                        WHERE l."memberId" = m."id" AND l."status" = 'AVAILABLE' AND l."remaining" > 0), 0),
  "pending" = COALESCE((SELECT SUM(l."points") FROM "LedgerEntry" l
                        WHERE l."memberId" = m."id" AND l."status" = 'PENDING'), 0),
  "lifetimeEarned" = TRUNC(m."lifetimeEarned" * c.f)::int,
  "lifetimeSpent" = TRUNC(m."lifetimeSpent" * c.f)::int,
  "tierPointsOffset" = 0
FROM "_coin_factor" c WHERE m."shop" = c."shop";

-- ₹ code rewards are replaced by coins-to-store-credit in the cart.
UPDATE "Reward" r SET "active" = false
FROM "_coin_factor" c WHERE r."shop" = c."shop" AND r."type" = 'FIXED_AMOUNT';

-- New program settings. Earn rules go back to the (coin) defaults; the FAQ and
-- visitor copy fall back to the new defaults, which talk about coins.
UPDATE "ProgramSettings" p SET
  "pointsPerCurrency" = 0.03,
  "pointValue" = 1,
  "expiryDays" = 90,
  "sliderStep" = 1,
  "sliderMinPoints" = 10,
  "storeCreditEnabled" = true,
  "earnRules" = '{}'::jsonb,
  "widget" = (p."widget"::jsonb - 'faq' - 'guestBody' - 'guestHeadline')
FROM "_coin_factor" c WHERE p."shop" = c."shop";

-- Tiers keep their thresholds (5,000 / 15,000), which now mean ₹ spent in 12 months.
UPDATE "Tier" t SET "perks" = ARRAY['3% back in coins', 'Birthday coins', 'Order-streak bonus']
FROM "_coin_factor" c WHERE t."shop" = c."shop" AND t."name" = 'Silver';
UPDATE "Tier" t SET "perks" = ARRAY['1.25x coins on every order', 'Free shipping, no minimum', '15-day returns', 'Early access to drops']
FROM "_coin_factor" c WHERE t."shop" = c."shop" AND t."name" = 'Gold';
UPDATE "Tier" t SET "perks" = ARRAY['1.5x coins on every order', 'Free express shipping', '30-day returns', '48h early access + invite-only drops']
FROM "_coin_factor" c WHERE t."shop" = c."shop" AND t."name" = 'Platinum';

DROP TABLE "_coin_factor";
