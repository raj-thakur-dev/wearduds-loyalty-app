import prisma from "../db.server";
import { customerAccountContext } from "../loyalty/extension-auth.server";
import { errorResponse, json } from "../loyalty/http.server";
import { findMember } from "../loyalty/members.server";

// GET ?order=gid://shopify/Order/123 → points for that order, only if it belongs to the signed-in customer.
export async function loader({ request }) {
  let cors = (r) => r;
  try {
    const ctx = await customerAccountContext(request);
    cors = ctx.cors;
    const orderId = (new URL(request.url).searchParams.get("order") || "").match(/(\d+)$/)?.[1];
    const member = await findMember(ctx.shop, ctx.customerId);
    if (!orderId || !member) return cors(json({ order: null }));
    const lo = await prisma.loyaltyOrder.findFirst({ where: { shop: ctx.shop, orderId, memberId: member.id } });
    if (!lo) return cors(json({ order: null }));
    return cors(
      json({
        order: {
          points: Math.max(0, lo.points - lo.pointsReversed),
          status: lo.status,
          releaseAt: lo.releaseAt,
          deliveredAt: lo.deliveredAt,
        },
      }),
    );
  } catch (err) {
    return errorResponse(err, cors);
  }
}
