import { authenticate } from "../shopify.server";

/**
 * Wraps a webhook handler. Bad signatures are rejected by `authenticate.webhook`.
 * Handlers are idempotent, so on an unexpected error we return 500 and let
 * Shopify retry rather than lose points.
 */
export function webhookAction(handler) {
  return async ({ request }) => {
    const { payload, topic, shop, admin } = await authenticate.webhook(request);
    try {
      await handler({ payload, topic, shop, admin });
      return new Response(null, { status: 200 });
    } catch (err) {
      console.error(`[club] webhook ${topic} failed for ${shop}:`, err);
      return new Response(null, { status: 500 });
    }
  };
}
