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
 * Idempotent: if a points_transactions row already exists for this
 * order_id, the function returns early without double-awarding.
 *
 * @param {string} shopifyCustomerId - The customer's Shopify ID.
 * @param {number} orderTotal - The total order amount in rupees.
 * @param {string} orderId - The Shopify order ID.
 * @returns {Promise<{pointsEarned: number, newBalance: number, newTier: string, tierChanged: boolean, alreadyProcessed?: boolean}>}
 */
export async function awardPoints(shopifyCustomerId, orderTotal, orderId) {
  try {
    // 0. Idempotency guard — has this order already been processed?
    const { data: existingTx, error: existingTxError } = await supabase
      .from('points_transactions')
      .select('id')
      .eq('order_id', orderId)
      .eq('type', 'earned')
      .maybeSingle();

    if (existingTxError) {
      throw new Error(`Failed to check for existing transaction: ${existingTxError.message}`);
    }

    if (existingTx) {
      console.log(`[awardPoints] Order ${orderId} already processed — skipping duplicate webhook.`);
      return { pointsEarned: 0, newBalance: null, newTier: null, tierChanged: false, alreadyProcessed: true };
    }

    // 1. Fetch the existing member record (need internal id + balances)
    const { data: member, error: fetchError } = await supabase
      .from('loyalty_members')
      .select('id, points_balance, total_spent')
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
      .eq('id', member.id);

    if (updateError) {
      throw new Error(`Failed to update loyalty member: ${updateError.message}`);
    }

    // 5. Log the transaction — using the REAL column names
    const { error: insertError } = await supabase
      .from('points_transactions')
      .insert({
        member_id: member.id,               // internal uuid, not shopify id
        order_id: orderId,
        points: pointsEarned,                // "points", not "points_earned"
        type: 'earned',
        order_amount: orderTotal,            // "order_amount", not "order_total"
        description: `Order #${orderId} — ₹${orderTotal} × ${
          previousTier === 'legend' ? '2.0' : previousTier === 'streeter' ? '1.5' : '1.0'
        } = ${pointsEarned} pts`,
        created_by: 'system',
      });

    if (insertError) {
      // If this fails, the balance update above already succeeded — roll it back
      // rather than leaving points_balance out of sync with the transaction log.
      await supabase
        .from('loyalty_members')
        .update({
          points_balance: member.points_balance,
          total_spent: member.total_spent,
          tier: previousTier,
        })
        .eq('id', member.id);

      throw new Error(`Failed to log points transaction (balance update rolled back): ${insertError.message}`);
    }

    return { pointsEarned, newBalance, newTier, tierChanged };
  } catch (err) {
    console.error('[awardPoints] Error:', err.message);
    throw err;
  }
}