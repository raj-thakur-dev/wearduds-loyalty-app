import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getLoyaltySettings, getRedeemOptions } from "../loyalty-settings.server";

export async function action({ request }) {
  const { admin } = await authenticate.public.appProxy(request);

  if (!admin) {
    return Response.json({ error: "Unable to authenticate with store" }, { status: 401 });
  }

  const body = await request.json();
  const { customer_id: customerId, points_cost: pointsCost } = body;

  if (!customerId || !pointsCost) {
    return Response.json({ error: "Missing customer_id or points_cost" }, { status: 400 });
  }

  const settings = await getLoyaltySettings();
  const redeemOptions = getRedeemOptions(settings);
  const option = redeemOptions.find((opt) => opt.points === Number(pointsCost));

  if (!option) {
    return Response.json({ error: "Invalid redemption option" }, { status: 400 });
  }

  const member = await prisma.loyaltyMember.findUnique({
    where: { shopifyCustomerId: String(customerId) },
  });

  if (!member || member.points < pointsCost) {
    return Response.json({ error: "Not enough points" }, { status: 400 });
  }

  // Generate a unique code
  const code = `DUDS-${option.amount}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  // Create the discount code in Shopify via Admin API
  const response = await admin.graphql(
    `#graphql
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        basicCodeDiscount: {
          title: `WearDuds Loyalty Reward - ${code}`,
          code,
          startsAt: new Date().toISOString(),
          customerSelection: { all: true },
          customerGets: {
            value: {
              discountAmount: {
                amount: option.amount,
                appliesOnEachItem: false,
              },
            },
            items: { all: true },
          },
          appliesOncePerCustomer: true,
          usageLimit: 1,
        },
      },
    }
  );

  const result = await response.json();
  const userErrors = result.data?.discountCodeBasicCreate?.userErrors;

  if (userErrors && userErrors.length > 0) {
    return Response.json({ error: userErrors[0].message }, { status: 500 });
  }

  // Deduct points, log transaction, and save the redeemed code — all together
  const [updatedMember] = await prisma.$transaction([
    prisma.loyaltyMember.update({
      where: { shopifyCustomerId: String(customerId) },
      data: { points: { decrement: pointsCost } },
    }),
    prisma.loyaltyTransaction.create({
      data: {
        shopifyCustomerId: String(customerId),
        description: `Redeemed ${option.value} discount code`,
        points: -pointsCost,
      },
    }),
    prisma.redeemedCode.create({
      data: {
        shopifyCustomerId: String(customerId),
        discountCode: code,
        pointsCost,
        discountValue: option.value,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
      },
    }),
  ]);

  return Response.json({
    success: true,
    code,
    value: option.value,
    remainingPoints: updatedMember.points,
  });
}