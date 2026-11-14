import { authenticate } from "../shopify.server";
import { buildState } from "../loyalty/storefront.server";
import { errorResponse, json, rateLimit } from "../loyalty/http.server";
import { noteSignals, storefrontSignals } from "../loyalty/signals.server";

// GET /apps/loyalty/state?cart=1499.00
// Shopify signs every proxied request. The only customer identity we trust is
// the signed `logged_in_customer_id`; anything the browser sends is ignored.
export async function loader({ request }) {
  try {
    const { session, admin } = await authenticate.public.appProxy(request);
    if (!session) return json({ error: "App not installed", code: "NO_SESSION" }, 503);
    const url = new URL(request.url);
    const customerId = url.searchParams.get("logged_in_customer_id") || null;
    rateLimit(`state:${session.shop}:${customerId || request.headers.get("x-forwarded-for") || "anon"}`, 60, 60000);
    const cart = url.searchParams.get("cart");
    const cartSubtotal = cart !== null && cart !== "" && Number.isFinite(Number(cart)) ? Number(cart) : null;
    noteSignals(session.shop, storefrontSignals(url.searchParams.get("sf")));
    const state = await buildState(session.shop, customerId, { cartSubtotal, admin });
    return json(state);
  } catch (err) {
    return errorResponse(err);
  }
}
