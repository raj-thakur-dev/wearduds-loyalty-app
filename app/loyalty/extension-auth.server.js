import { authenticate, unauthenticated } from "../shopify.server";
import { customerIdFromGid } from "./members.server";
import { normaliseShop } from "./http.server";
import { LoyaltyError } from "./ledger.server";

/**
 * Verifies a customer account UI extension request (session token in the
 * Authorization header). Returns the shop, signed-in customer and a CORS wrapper.
 */
export async function customerAccountContext(request) {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);
  const shop = normaliseShop(sessionToken.dest);
  const customerId = customerIdFromGid(sessionToken.sub);
  if (!shop) throw new LoyaltyError("BAD_TOKEN", "Invalid session.", 401);
  if (!customerId) throw new LoyaltyError("SIGN_IN", "Sign in to continue.", 401);
  const { admin } = await unauthenticated.admin(shop);
  return { shop, customerId, admin, cors };
}

/** Checkout / thank-you page extension request. Customer may be a guest. */
export async function checkoutContext(request) {
  const { sessionToken, cors } = await authenticate.public.checkout(request);
  const shop = normaliseShop(sessionToken.dest);
  if (!shop) throw new LoyaltyError("BAD_TOKEN", "Invalid session.", 401);
  const customerId = sessionToken.sub && String(sessionToken.sub).includes("Customer") ? customerIdFromGid(sessionToken.sub) : null;
  return { shop, customerId, cors };
}
