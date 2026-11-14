import { buildState } from "../loyalty/storefront.server";
import { customerAccountContext } from "../loyalty/extension-auth.server";
import { errorResponse, json } from "../loyalty/http.server";
import { noteSignals } from "../loyalty/signals.server";

// GET from the customer account Rewards page / profile block.
export async function loader({ request }) {
  let cors = (r) => r;
  try {
    const ctx = await customerAccountContext(request);
    cors = ctx.cors;
    noteSignals(ctx.shop, ["account"]);
    const state = await buildState(ctx.shop, ctx.customerId, { admin: ctx.admin });
    return cors(json(state));
  } catch (err) {
    return errorResponse(err, cors);
  }
}
