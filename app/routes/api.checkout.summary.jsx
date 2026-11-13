import { checkoutContext } from "../loyalty/extension-auth.server";
import { errorResponse, json } from "../loyalty/http.server";
import { getSettings, getTiers } from "../loyalty/settings.server";
import { findMember } from "../loyalty/members.server";
import { purchasePoints } from "../loyalty/math";

// Thank-you page: "You'll earn X points" for members, a join nudge for guests.
export async function loader({ request }) {
  let cors = (r) => r;
  try {
    const ctx = await checkoutContext(request);
    cors = ctx.cors;
    const url = new URL(request.url);
    const subtotal = Math.max(0, Number(url.searchParams.get("subtotal") || 0));
    const [settings, tiers] = await Promise.all([getSettings(ctx.shop), getTiers(ctx.shop)]);
    const member = ctx.customerId ? await findMember(ctx.shop, ctx.customerId) : null;
    const tier = member ? tiers.find((t) => t.id === member.tierId) : tiers[0];
    const points = settings.earnRules.purchase.enabled ? purchasePoints(subtotal, settings.pointsPerCurrency, tier?.multiplier || 1) : 0;
    return cors(
      json({
        live: settings.isLive,
        programName: settings.programName,
        points,
        holdDays: settings.holdDays,
        creditTrigger: settings.creditTrigger,
        signupPoints: settings.earnRules.signup.enabled ? settings.earnRules.signup.points : 0,
        member: member ? { balance: member.balance, pending: member.pending, tier: tier?.name || null } : null,
      }),
    );
  } catch (err) {
    return errorResponse(err, cors);
  }
}
