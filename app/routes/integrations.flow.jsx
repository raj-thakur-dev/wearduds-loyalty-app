import { awardCustomEvent, awardReview } from "../loyalty/actions.server";
import { verifyIntegration } from "../loyalty/integrations.server";
import { errorResponse, json, readBody } from "../loyalty/http.server";
import { LoyaltyError } from "../loyalty/ledger.server";

// Shopify Flow "Send HTTP request" (or any trusted system):
//   POST https://<app>/integrations/flow   header: X-Club-Key: <integration secret>
//   { "shop": "...myshopify.com", "type": "review", "customer_id": 123, "review_id": "...", "body": "...", "has_photo": true }
//   { "shop": "...myshopify.com", "type": "custom", "customer_id": 123, "points": 100, "reason": "Diwali bonus", "key": "diwali-2026-123" }
export async function action({ request }) {
  try {
    const body = await readBody(request);
    const shop = await verifyIntegration(body.shop, request.headers.get("x-club-key"));
    if (body.type === "review") {
      const result = await awardReview(shop, {
        customerId: body.customer_id,
        email: body.email,
        reviewId: `flow:${body.review_id}`,
        body: body.body,
        hasPhoto: !!body.has_photo,
        verifiedBuyer: body.verified_buyer,
        published: body.published,
      });
      return json({ ok: true, result });
    }
    if (body.type === "custom") {
      return json({ ok: true, result: await awardCustomEvent(shop, { customerId: body.customer_id, points: body.points, reason: body.reason, key: body.key }) });
    }
    throw new LoyaltyError("BAD_TYPE", "type must be review or custom");
  } catch (err) {
    return errorResponse(err);
  }
}
