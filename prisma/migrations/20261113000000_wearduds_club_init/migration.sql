-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CreditTrigger" AS ENUM ('PAID', 'FULFILLED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "RewardType" AS ENUM ('FIXED_AMOUNT', 'PERCENTAGE', 'FREE_SHIPPING');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('PURCHASE', 'SIGNUP', 'BIRTHDAY', 'BIRTHDAY_SETUP', 'REVIEW', 'REFERRAL_REFERRER', 'REFERRAL_FRIEND', 'INSTAGRAM', 'NEWSLETTER', 'RETRO', 'ADJUSTMENT', 'REDEMPTION', 'REDEMPTION_RESTORED', 'REFUND_REVERSAL', 'EXPIRY');

-- CreateEnum
CREATE TYPE "LedgerStatus" AS ENUM ('PENDING', 'AVAILABLE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('PENDING', 'ISSUED', 'USED', 'EXPIRED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "RedemptionKind" AS ENUM ('DISCOUNT_CODE', 'STORE_CREDIT');

-- CreateEnum
CREATE TYPE "OrderLoyaltyStatus" AS ENUM ('PENDING', 'CREDITED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('SIGNED_UP', 'REWARDED', 'REJECTED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramSettings" (
    "shop" TEXT NOT NULL,
    "programName" TEXT NOT NULL DEFAULT 'The Wearduds Club',
    "isLive" BOOLEAN NOT NULL DEFAULT false,
    "currencyCode" TEXT NOT NULL DEFAULT 'INR',
    "pointsPerCurrency" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "pointValue" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "creditTrigger" "CreditTrigger" NOT NULL DEFAULT 'DELIVERED',
    "holdDays" INTEGER NOT NULL DEFAULT 7,
    "fallbackDays" INTEGER NOT NULL DEFAULT 15,
    "expiryDays" INTEGER NOT NULL DEFAULT 365,
    "expiryWarningDays" INTEGER NOT NULL DEFAULT 30,
    "maxRedeemPercent" INTEGER NOT NULL DEFAULT 20,
    "codeExpiryDays" INTEGER NOT NULL DEFAULT 90,
    "codePrefix" TEXT NOT NULL DEFAULT 'WD',
    "combinesWithProduct" BOOLEAN NOT NULL DEFAULT false,
    "combinesWithOrder" BOOLEAN NOT NULL DEFAULT false,
    "combinesWithShipping" BOOLEAN NOT NULL DEFAULT true,
    "sliderEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sliderStep" INTEGER NOT NULL DEFAULT 100,
    "sliderMinPoints" INTEGER NOT NULL DEFAULT 500,
    "storeCreditEnabled" BOOLEAN NOT NULL DEFAULT false,
    "restorePointsOnCancel" BOOLEAN NOT NULL DEFAULT true,
    "downgradeAfterDays" INTEGER NOT NULL DEFAULT 365,
    "excludeTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "earnRules" JSONB NOT NULL,
    "widget" JSONB NOT NULL,
    "integrationSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgramSettings_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "Tier" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "perks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "color" TEXT NOT NULL DEFAULT '#111111',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "RewardType" NOT NULL DEFAULT 'FIXED_AMOUNT',
    "pointsCost" INTEGER NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "minSubtotal" DOUBLE PRECISION,
    "minTierId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "pending" INTEGER NOT NULL DEFAULT 0,
    "lifetimeEarned" INTEGER NOT NULL DEFAULT 0,
    "lifetimeSpent" INTEGER NOT NULL DEFAULT 0,
    "tierId" TEXT,
    "tierLocked" BOOLEAN NOT NULL DEFAULT false,
    "tierPointsOffset" INTEGER NOT NULL DEFAULT 0,
    "tierAchievedAt" TIMESTAMP(3),
    "referralCode" TEXT NOT NULL,
    "referredById" TEXT,
    "birthMonth" INTEGER,
    "birthDay" INTEGER,
    "birthYear" INTEGER,
    "signedInAt" TIMESTAMP(3),
    "instagramId" TEXT,
    "instagramHandle" TEXT,
    "instagramCode" TEXT,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "totalSpent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastOrderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "type" "LedgerType" NOT NULL,
    "status" "LedgerStatus" NOT NULL DEFAULT 'AVAILABLE',
    "remaining" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "orderId" TEXT,
    "description" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redemption" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "rewardId" TEXT,
    "kind" "RedemptionKind" NOT NULL DEFAULT 'DISCOUNT_CODE',
    "points" INTEGER NOT NULL,
    "rewardType" "RewardType" NOT NULL DEFAULT 'FIXED_AMOUNT',
    "value" DOUBLE PRECISION NOT NULL,
    "label" TEXT NOT NULL,
    "code" TEXT,
    "discountNodeId" TEXT,
    "minSubtotal" DOUBLE PRECISION,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3),
    "usedOrderId" TEXT,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Redemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyOrder" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT,
    "memberId" TEXT NOT NULL,
    "eligibleAmount" DOUBLE PRECISION NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "points" INTEGER NOT NULL,
    "refundedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pointsReversed" INTEGER NOT NULL DEFAULT 0,
    "status" "OrderLoyaltyStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "releaseAt" TIMESTAMP(3),
    "usedCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "refundIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'SIGNED_UP',
    "rejectReason" TEXT,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "params" JSONB,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tier_shop_threshold_idx" ON "Tier"("shop", "threshold");

-- CreateIndex
CREATE UNIQUE INDEX "Tier_shop_name_key" ON "Tier"("shop", "name");

-- CreateIndex
CREATE INDEX "Reward_shop_active_idx" ON "Reward"("shop", "active");

-- CreateIndex
CREATE INDEX "Member_shop_email_idx" ON "Member"("shop", "email");

-- CreateIndex
CREATE INDEX "Member_shop_tierId_idx" ON "Member"("shop", "tierId");

-- CreateIndex
CREATE INDEX "Member_shop_birthMonth_birthDay_idx" ON "Member"("shop", "birthMonth", "birthDay");

-- CreateIndex
CREATE UNIQUE INDEX "Member_shop_customerId_key" ON "Member"("shop", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_shop_referralCode_key" ON "Member"("shop", "referralCode");

-- CreateIndex
CREATE UNIQUE INDEX "Member_shop_instagramId_key" ON "Member"("shop", "instagramId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_shop_instagramCode_key" ON "Member"("shop", "instagramCode");

-- CreateIndex
CREATE INDEX "LedgerEntry_memberId_createdAt_idx" ON "LedgerEntry"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_shop_status_availableAt_idx" ON "LedgerEntry"("shop", "status", "availableAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_shop_expiresAt_idx" ON "LedgerEntry"("shop", "expiresAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_shop_orderId_idx" ON "LedgerEntry"("shop", "orderId");

-- CreateIndex
CREATE INDEX "LedgerEntry_shop_type_createdAt_idx" ON "LedgerEntry"("shop", "type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_shop_idempotencyKey_key" ON "LedgerEntry"("shop", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Redemption_memberId_status_idx" ON "Redemption"("memberId", "status");

-- CreateIndex
CREATE INDEX "Redemption_shop_status_expiresAt_idx" ON "Redemption"("shop", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_shop_code_key" ON "Redemption"("shop", "code");

-- CreateIndex
CREATE INDEX "LoyaltyOrder_shop_status_releaseAt_idx" ON "LoyaltyOrder"("shop", "status", "releaseAt");

-- CreateIndex
CREATE INDEX "LoyaltyOrder_memberId_idx" ON "LoyaltyOrder"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyOrder_shop_orderId_key" ON "LoyaltyOrder"("shop", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_refereeId_key" ON "Referral"("refereeId");

-- CreateIndex
CREATE INDEX "Referral_shop_referrerId_idx" ON "Referral"("shop", "referrerId");

-- CreateIndex
CREATE INDEX "Referral_shop_status_idx" ON "Referral"("shop", "status");

-- CreateIndex
CREATE INDEX "JobRun_shop_kind_startedAt_idx" ON "JobRun"("shop", "kind", "startedAt");

-- AddForeignKey
ALTER TABLE "Reward" ADD CONSTRAINT "Reward_minTierId_fkey" FOREIGN KEY ("minTierId") REFERENCES "Tier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "Tier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "Reward"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyOrder" ADD CONSTRAINT "LoyaltyOrder_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
