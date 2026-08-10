import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/**
 * Determines the loyalty tier based on total amount spent.
 * @param {number} totalSpent - Total amount spent by the customer (in rupees).
 * @returns {'freshman'|'streeter'|'legend'} The tier name.
 */
export function getTier(totalSpent) {
  if (totalSpent >= 15000) return 'legend';
  if (totalSpent >= 5000) return 'streeter';
  return 'freshman';
}

/**
 * Calculates points earned for an order based on the tier multiplier.
 * @param {number} orderAmount - The order amount in rupees.
 * @param {'freshman'|'streeter'|'legend'} tier - The customer's current tier.
 * @returns {number} Points earned, rounded down to the nearest integer.
 */
export function calcPoints(orderAmount, tier) {
  const multipliers = {
    freshman: 1,
    streeter: 1.5,
    legend: 2,
  };
  const multiplier = multipliers[tier] ?? 1;
  return Math.floor(orderAmount * multiplier);
}

/**
 * Awards points to a customer for a completed order, updates their
 * balance and total spent, checks for a tier change, and logs the
 * transaction.
 *
 * @param {string} shopifyCustomerId - The customer's Shopify ID.
 * @param {number} orderTotal - The total order amount in rupees.
 * @param {string} orderId - The Shopify order ID.
 * @returns {Promise<{pointsEarned: number, newBalance: number, newTier: string, tierChanged: boolean}>}
 */
export async function awardPoints(shopifyCustomerId, orderTotal, orderId) {
  try {
    // 1. Fetch the existing member record
    const { data: member, error: fetchError } = await supabase
      .from('loyalty_members')
      .select('*')
      .eq('shopify_customer_id', shopifyCustomerId)
      .single();

    if (fetchError || !member) {
      throw new Error(
        `Loyalty member not found for customer ${shopifyCustomerId}: ${fetchError?.message ?? 'no record'}`
      );
    }

    const previousTier = getTier(member.total_spent);

    // 2. Calculate points for this order
    const pointsEarned = calcPoints(orderTotal, previousTier);

    // 3. Compute new totals
    const newBalance = member.points_balance + pointsEarned;
    const newTotalSpent = member.total_spent + orderTotal;
    const newTier = getTier(newTotalSpent);
    const tierChanged = newTier !== previousTier;

    // 4. Update the member record
    const { error: updateError } = await supabase
      .from('loyalty_members')
      .update({
        points_balance: newBalance,
        total_spent: newTotalSpent,
        tier: newTier,
      })
      .eq('shopify_customer_id', shopifyCustomerId);

    if (updateError) {
      throw new Error(`Failed to update loyalty member: ${updateError.message}`);
    }

    // 5. Log the transaction
    const { error: insertError } = await supabase
      .from('points_transactions')
      .insert({
        shopify_customer_id: shopifyCustomerId,
        order_id: orderId,
        points_earned: pointsEarned,
        order_total: orderTotal,
        tier_at_time: previousTier,
      });

    if (insertError) {
      throw new Error(`Failed to log points transaction: ${insertError.message}`);
    }

    return { pointsEarned, newBalance, newTier, tierChanged };
  } catch (err) {
    console.error('[awardPoints] Error:', err.message);
    throw err;
  }
}