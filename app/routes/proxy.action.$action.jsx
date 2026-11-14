import { authenticate } from "../shopify.server";
import { performAction } from "../loyalty/storefront.server";
import { errorResponse, json, rateLimit, readBody } from "../loyalty/http.server";
import { LoyaltyError } from "../loyalty/ledger.server";

const ACTIONS = new Set(["redeem", "birthday", "referral", "instagram"]);

// POST /apps/loyalty/action/:action  (redeem | birthday | referral | instagram)
export async function action({ request, params }) {
  try {
    if (request.method !== "POST") throw new LoyaltyError("METHOD", "Use POST.", 405);
    if (!ACTIONS.has(params.action)) throw new LoyaltyError("UNKNOWN_ACTION", "Unknown action.", 404);
    const { session, admin } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "App not installed", code: "NO_SESSION" }, 503);
    const customerId = new URL(request.url).searchParams.get("logged_in_customer_id") || null;
    if (!customerId) throw new LoyaltyError("SIGN_IN", "Sign in to continue.", 401);
    rateLimit(`action:${session.shop}:${customerId}`, 20, 60000);
    const body = await readBody(request);
    const result = await performAction(session.shop, customerId, params.action, body, admin);
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

export function loader() {
  return json({ error: "Use POST." }, 405);
}
