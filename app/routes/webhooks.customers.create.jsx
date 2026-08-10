import { authenticate } from "../shopify.server.js";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export const action = async ({ request }) => {
  const { payload, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const shopifyCustomerId = payload?.id;
    const email = payload?.email;

    if (!shopifyCustomerId) {
      console.log("No customer ID in payload — skipping loyalty signup.");
      return new Response();
    }

    const { error } = await supabase
      .from("loyalty_members")
      .upsert(
        {
          shopify_customer_id: String(shopifyCustomerId),
          email: email ?? null,
          points_balance: 0,
          total_spent: 0,
          tier: "freshman",
        },
        { onConflict: "shopify_customer_id", ignoreDuplicates: true }
      );

    if (error) {
      console.error(`Error creating loyalty member ${shopifyCustomerId}:`, error);
      return new Response();
    }

    console.log(`Loyalty member ensured: ${shopifyCustomerId} (${email})`);
  } catch (error) {
    console.error("Error processing customer creation webhook:", error);
  }

  return new Response();
};