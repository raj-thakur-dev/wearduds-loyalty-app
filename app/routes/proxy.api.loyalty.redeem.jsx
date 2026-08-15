import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getLoyaltySettings, getRedeemOptions } from "../loyalty-settings.server";

export async function action({ request }) {
  try {
    console.log("[REDEEM] Incoming request");

    const { admin } = await authenticate.public.appProxy(request);
    console.log("[REDEEM] Auth result - admin present:", !!admin);

    if (!admin) {
      console.error("[REDEEM] No admin client returned from appProxy auth");
      return Response.json({ error: "Unable to authenticate with store" }, { status: 401 });
    }

    const body = await request.json();
    console.log("[REDEEM] Body:", JSON.stringify(body));

    const { customer_id: customerId, points_cost: pointsCost } = body;

    if (!customerId || !pointsCost) {
      console.error("[REDEEM] Missing customer_id or points_cost");
      return Response.json({ error: "Missing customer_id or points_cost" }, { status: 400 });
    }

    const settings = await getLoyaltySettings();
    console.log("[REDEEM] Settings loaded:", JSON.stringify(settings));

    const redeemOptions = getRedeemOptions(settings);
    const option = redeemOptions.find((opt) => opt.points === Number(pointsCost));

    if (!option) {
      console.error("[REDEEM] Invalid redemption option for pointsCost:", pointsCost);
      return Response.json({ error: "Invalid redemption option" }, { status: 400 });
    }

    const member = await prisma.loyaltyMember.findUnique({
      where: { shopifyCustomerId: String(customerId) },
    });
    console.log("[REDEEM] Member found:", JSON.stringify(member));

    if (!member || member.points < pointsCost) {
      console.error("[REDEEM] Not enough points. Member points:", member?.points);
      return Response.json({ error: "Not enough points" }, { status: 400 });
    }

    const code = `DUDS-${option.amount}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    console.log("[REDEEM] Generated code:", code);

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
    console.log("[REDEEM] GraphQL result:", JSON.stringify(result));

    const userErrors = result.data?.discountCodeBasicCreate?.userErrors;

    if (userErrors && userErrors.length > 0) {
      console.error("[REDEEM] GraphQL userErrors:", JSON.stringify(userErrors));
      return Response.json({ error: userErrors[0].message }, { status: 500 });
    }

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
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        },
      }),
    ]);

    console.log("[REDEEM] Success. Updated member points:", updatedMember.points);

    return Response.json({
      success: true,
      code,
      value: option.value,
      remainingPoints: updatedMember.points,
    });
  } catch (err) {
    console.error("[REDEEM] UNCAUGHT ERROR:", err.message);
    console.error("[REDEEM] STACK:", err.stack);
    return Response.json({ error: "Internal error: " + err.message }, { status: 500 });
  }
}