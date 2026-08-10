import { authenticate } from "../shopify.server.js";
import { createClient } from "@supabase/supabase-js";
import { getTier } from "../lib/points-engine.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const orderId = String(payload?.order_id ?? payload?.id);

    if (!orderId) {
      console.log("No order ID in refund payload — skipping.");
      return new Response();
    }

    // 1. Find the original points transaction for this order
    const { data: transaction, error: txError } = await supabase
      .from("points_transactions")
      .select("*")
      .eq("order_id", orderId)
      .single();

    if (txError || !transaction) {
      console.log(`No points transaction found for order ${orderId} — nothing to reverse.`);
      return new Response();
    }

    const { shopify_customer_id: shopifyCustomerId, points_earned: pointsToDeduct, order_total: orderTotal } = transaction;

    // 2. Fetch the current member record
    const { data: member, error: memberError } = await supabase
      .from("loyalty_members")
      .select("*")
      .eq("shopify_customer_id", shopifyCustomerId)
      .single();

    if (memberError || !member) {
      console.error(`Loyalty member not found for customer ${shopifyCustomerId}:`, memberError?.message);
      return new Response();
    }

    // 3. Recalculate balances after removing this order's points/spend
    const newBalance = Math.max(0, member.points_balance - pointsToDeduct);
    const newTotalSpent = Math.max(0, member.total_spent - orderTotal);
    const newTier = getTier(newTotalSpent);

    // 4. Update the member record
    const { error: updateError } = await supabase
      .from("loyalty_members")
      .update({
        points_balance: newBalance,
        total_spent: newTotalSpent,
        tier: newTier,
      })
      .eq("shopify_customer_id", shopifyCustomerId);

    if (updateError) {
      console.error(`Failed to update loyalty member after refund:`, updateError.message);
      return new Response();
    }

    // 5. Remove the original transaction record so it can't be reversed twice
    await supabase
      .from("points_transactions")
      .delete()
      .eq("order_id", orderId);

    console.log(
      `Refund processed for order ${orderId}: deducted ${pointsToDeduct} points from customer ${shopifyCustomerId}. ` +
      `New balance: ${newBalance}, new tier: ${newTier}`
    );
  } catch (error) {
    console.error("Error processing refund webhook:", error);
  }

  return new Response();
};