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

    // 1. Find the original "earned" points transaction for this order
    const { data: transaction, error: txError } = await supabase
      .from("points_transactions")
      .select("*")
      .eq("order_id", orderId)
      .eq("type", "earned")
      .single();

    if (txError || !transaction) {
      console.log(`No points transaction found for order ${orderId} — nothing to reverse.`);
      return new Response();
    }

    // Real column names: member_id (uuid FK), points, order_amount
    const { member_id: memberId, points: pointsToDeduct, order_amount: orderAmount } = transaction;

    // 2. Fetch the current member record
    const { data: member, error: memberError } = await supabase
      .from("loyalty_members")
      .select("*")
      .eq("id", memberId)
      .single();

    if (memberError || !member) {
      console.error(`Loyalty member not found for id ${memberId}:`, memberError?.message);
      return new Response();
    }

    // 3. Recalculate balances after removing this order's points/spend
    const newBalance = Math.max(0, member.points_balance - pointsToDeduct);
    const newTotalSpent = Math.max(0, member.total_spent - orderAmount);
    const newTier = getTier(newTotalSpent);

    // 4. Update the member record
    const { error: updateError } = await supabase
      .from("loyalty_members")
      .update({
        points_balance: newBalance,
        total_spent: newTotalSpent,
        tier: newTier,
      })
      .eq("id", memberId);

    if (updateError) {
      console.error(`Failed to update loyalty member after refund:`, updateError.message);
      return new Response();
    }

    // 5. Log a reversing transaction instead of deleting the original.
    //    Deleting destroys your audit trail and breaks a second partial
    //    refund on the same order (nothing left to find/reverse).
    //    A negative "refund" row keeps history intact and is itself
    //    idempotent-safe if you later check for an existing refund row
    //    per order_id.
    const { error: insertError } = await supabase
      .from("points_transactions")
      .insert({
        member_id: memberId,
        order_id: orderId,
        points: -pointsToDeduct,
        type: "refund",
        order_amount: -orderAmount,
        description: `Refund for order #${orderId} — reversed ${pointsToDeduct} pts`,
        created_by: "system",
      });

    if (insertError) {
      console.error(`Failed to log refund transaction:`, insertError.message);
      // Balance was already adjusted above; this only affects the audit trail.
    }

    console.log(
      `Refund processed for order ${orderId}: deducted ${pointsToDeduct} points from member ${memberId}. ` +
      `New balance: ${newBalance}, new tier: ${newTier}`
    );
  } catch (error) {
    console.error("Error processing refund webhook:", error);
  }

  return new Response();
};