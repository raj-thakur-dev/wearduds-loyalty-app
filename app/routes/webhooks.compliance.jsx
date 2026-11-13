import prisma from "../db.server";
import { webhookAction } from "../loyalty/webhook.server";

// Mandatory privacy webhooks.
//  customers/data_request: the merchant can export a member from the admin
//    (Members > member > Export), so we only log the request.
//  customers/redact: delete the member and their history.
//  shop/redact: 48h after uninstall, delete everything for the shop.
export const action = webhookAction(async ({ topic, shop, payload }) => {
  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      console.log(`[club] data request for customer ${payload?.customer?.id} on ${shop}`);
      return;
    case "CUSTOMERS_REDACT": {
      const customerId = String(payload?.customer?.id || "");
      if (customerId) await prisma.member.deleteMany({ where: { shop, customerId } });
      return;
    }
    case "SHOP_REDACT":
      await prisma.$transaction([
        prisma.ledgerEntry.deleteMany({ where: { shop } }),
        prisma.redemption.deleteMany({ where: { shop } }),
        prisma.loyaltyOrder.deleteMany({ where: { shop } }),
        prisma.referral.deleteMany({ where: { shop } }),
        prisma.member.deleteMany({ where: { shop } }),
        prisma.reward.deleteMany({ where: { shop } }),
        prisma.tier.deleteMany({ where: { shop } }),
        prisma.jobRun.deleteMany({ where: { shop } }),
        prisma.programSettings.deleteMany({ where: { shop } }),
        prisma.session.deleteMany({ where: { shop } }),
      ]);
      return;
    default:
      return;
  }
});
