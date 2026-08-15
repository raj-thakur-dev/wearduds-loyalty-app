-- CreateTable
CREATE TABLE "LoyaltySettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pointsPerRupee" REAL NOT NULL DEFAULT 0.01,
    "silverThreshold" INTEGER NOT NULL DEFAULT 500,
    "goldThreshold" INTEGER NOT NULL DEFAULT 1500,
    "redeem500Value" INTEGER NOT NULL DEFAULT 50,
    "redeem1000Value" INTEGER NOT NULL DEFAULT 120,
    "redeem2000Value" INTEGER NOT NULL DEFAULT 300
);
