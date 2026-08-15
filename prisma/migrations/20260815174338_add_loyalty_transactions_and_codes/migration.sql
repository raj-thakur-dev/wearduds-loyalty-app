-- CreateTable
CREATE TABLE "LoyaltyMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyCustomerId" TEXT NOT NULL,
    "email" TEXT,
    "firstName" TEXT,
    "points" INTEGER NOT NULL DEFAULT 0,
    "tier" TEXT NOT NULL DEFAULT 'Bronze'
);

-- CreateTable
CREATE TABLE "LoyaltyTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyCustomerId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RedeemedCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyCustomerId" TEXT NOT NULL,
    "discountCode" TEXT NOT NULL,
    "pointsCost" INTEGER NOT NULL,
    "discountValue" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyMember_shopifyCustomerId_key" ON "LoyaltyMember"("shopifyCustomerId");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_shopifyCustomerId_idx" ON "LoyaltyTransaction"("shopifyCustomerId");

-- CreateIndex
CREATE INDEX "RedeemedCode_shopifyCustomerId_idx" ON "RedeemedCode"("shopifyCustomerId");
