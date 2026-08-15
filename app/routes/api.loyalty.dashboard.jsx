import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getLoyaltySettings, getTierInfo, getRedeemOptions } from "../loyalty-settings.server";

export async function loader({ request }) {
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
  const redeemOptions = getRedeemOptions(settings);

  const transactions = await prisma.loyaltyTransaction.findMany({
    where: { shopifyCustomerId: String(customerId) },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const activeCodes = await prisma.redeemedCode.findMany({
    where: {
      shopifyCustomerId: String(customerId),
      used: false,
    },
    orderBy: { createdAt: "desc" },
  });

  return Response.json({
    points,
    ...tierInfo,
    redeemOptions: redeemOptions.map((opt) => ({
      ...opt,
      canRedeem: points >= opt.points,
    })),
    transactions: transactions.map((t) => ({
      id: t.id,
      description: t.description,
      points: t.points,
      date: t.createdAt,
    })),
    activeCodes: activeCodes.map((c) => ({
      id: c.id,
      code: c.discountCode,
      value: c.discountValue,
      expiresAt: c.expiresAt,
    })),
  });
}