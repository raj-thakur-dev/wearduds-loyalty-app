import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getLoyaltySettings, getTierInfo } from "../loyalty-settings.server";

export async function loader({ request }) {
  // Verifies this request genuinely came from Shopify's app proxy
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id");

  if (!customerId) {
    return Response.json({ error: "Missing customer_id" }, { status: 400 });
  }

  const settings = await getLoyaltySettings();

  const member = await prisma.loyaltyMember.findUnique({
    where: { shopifyCustomerId: String(customerId) },
  });

  const points = member?.points || 0;
  const tierInfo = getTierInfo(points, settings);

  return Response.json({
    points,
    ...tierInfo,
  });
}