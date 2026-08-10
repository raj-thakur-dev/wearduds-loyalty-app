import { authenticate } from "../shopify.server.js";
import { awardPoints } from "../lib/points-engine.js";

/**
 * Webhook handler for the ORDERS_PAID topic.
 * Fires whenever an order is marked as paid on the connected store.
 * Awards loyalty points to the customer via the points engine.
 */
export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const shopifyCustomerId = payload?.customer?.id;
    const orderTotal = parseFloat(payload?.total_price);
    const orderId = payload?.id;

    if (!shopifyCustomerId) {
      console.log("No customer attached to this order — skipping points award.");
      return new Response();
    }

    if (!orderTotal || isNaN(orderTotal)) {
      console.error(`Invalid order total for order ${orderId}:`, payload?.total_price);
      return new Response();
    }

    const result = await awardPoints(
      String(shopifyCustomerId),
      orderTotal,
      String(orderId)
    );

    console.log(
      `Awarded ${result.pointsEarned} points to customer ${shopifyCustomerId}. ` +
      `New balance: ${result.newBalance}. Tier: ${result.newTier}` +
      (result.tierChanged ? " (TIER CHANGED)" : "")
    );
  } catch (error) {
    // Log the error but still return 200 so Shopify doesn't endlessly retry
    // a webhook that will keep failing for the same reason.
    console.error("Error awarding points for order webhook:", error);
  }

  return new Response();
};