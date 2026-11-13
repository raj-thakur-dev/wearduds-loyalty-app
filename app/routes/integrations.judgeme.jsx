import { awardReview } from "../loyalty/actions.server";
import { parseJudgeMeReview, verifyIntegration } from "../loyalty/integrations.server";
import { errorResponse, json, readBody } from "../loyalty/http.server";

// Judge.me > Settings > Integrations > Webhooks (review/created + review/updated):
//   https://<app>/integrations/judgeme?shop=<shop>.myshopify.com&key=<integration secret>
export async function action({ request }) {
  try {
    const url = new URL(request.url);
    const shop = await verifyIntegration(url.searchParams.get("shop"), url.searchParams.get("key"));
    const review = parseJudgeMeReview(await readBody(request));
    if (!review.reviewId) return json({ ok: true, skipped: "no_review_id" });
    const result = await awardReview(shop, review);
    return json({ ok: true, result: result?.skipped || (result?.duplicate ? "duplicate" : "awarded") });
  } catch (err) {
    return errorResponse(err);
  }
}
