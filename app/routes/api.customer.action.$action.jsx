import { performAction } from "../loyalty/storefront.server";
import { customerAccountContext } from "../loyalty/extension-auth.server";
import { errorResponse, json, rateLimit, readBody } from "../loyalty/http.server";
import { LoyaltyError } from "../loyalty/ledger.server";

const ACTIONS = new Set(["redeem", "birthday", "referral", "instagram"]);

export async function loader({ request }) {
  // CORS preflight is answered by authenticate.public.customerAccount.
  let cors = (r) => r;
  try {
    const ctx = await customerAccountContext(request);
    cors = ctx.cors;
    return cors(json({ error: "Use POST." }, 405));
  } catch (err) {
    return errorResponse(err, cors);
  }
}

export async function action({ request, params }) {
  let cors = (r) => r;
  try {
    const ctx = await customerAccountContext(request);
    cors = ctx.cors;
    if (!ACTIONS.has(params.action)) throw new LoyaltyError("UNKNOWN_ACTION", "Unknown action.", 404);
    rateLimit(`ca-action:${ctx.shop}:${ctx.customerId}`, 20, 60000);
    const body = await readBody(request);
    const result = await performAction(ctx.shop, ctx.customerId, params.action, body, ctx.admin);
    return cors(json(result));
  } catch (err) {
    return errorResponse(err, cors);
  }
}
