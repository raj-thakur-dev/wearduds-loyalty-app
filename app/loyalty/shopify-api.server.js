import { LoyaltyError } from "./ledger.server";
import { customerGid } from "./members.server";

// Thin wrappers over the Admin GraphQL API. Each returns plain data or throws.

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body.errors?.length) {
    const message = body.errors.map((e) => e.message).join("; ");
    throw new LoyaltyError("SHOPIFY_ERROR", message, 502);
  }
  return body.data;
}

function combinesWith(settings) {
  return {
    productDiscounts: !!settings.combinesWithProduct,
    orderDiscounts: !!settings.combinesWithOrder,
    shippingDiscounts: !!settings.combinesWithShipping,
  };
}

/**
 * Creates a single-use discount code that only `customerId` can use.
 * kind: FIXED_AMOUNT | PERCENTAGE | FREE_SHIPPING
 */
export async function createRewardDiscount(admin, settings, { customerId, code, title, rewardType, value, minSubtotal, endsAt }) {
  const base = {
    title,
    code,
    startsAt: new Date().toISOString(),
    endsAt: endsAt.toISOString(),
    context: { customers: { add: [customerGid(customerId)] } },
    usageLimit: 1,
    appliesOncePerCustomer: true,
    combinesWith: combinesWith(settings),
    minimumRequirement: minSubtotal
      ? { subtotal: { greaterThanOrEqualToSubtotal: String(minSubtotal) } }
      : undefined,
  };

  if (rewardType === "FREE_SHIPPING") {
    const data = await gql(
      admin,
      `#graphql
      mutation ClubFreeShipping($input: DiscountCodeFreeShippingInput!) {
        discountCodeFreeShippingCreate(freeShippingCodeDiscount: $input) {
          codeDiscountNode { id }
          userErrors { field message code }
        }
      }`,
      { input: { ...base, destination: { all: true } } },
    );
    return unwrapDiscount(data.discountCodeFreeShippingCreate);
  }

  const customerGets = {
    items: { all: true },
    value:
      rewardType === "PERCENTAGE"
        ? { percentage: Math.min(1, Number(value) / 100) }
        : { discountAmount: { amount: String(value), appliesOnEachItem: false } },
  };
  const data = await gql(
    admin,
    `#graphql
    mutation ClubDiscount($input: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $input) {
        codeDiscountNode { id }
        userErrors { field message code }
      }
    }`,
    { input: { ...base, customerGets } },
  );
  return unwrapDiscount(data.discountCodeBasicCreate);
}

function unwrapDiscount(payload) {
  if (payload?.userErrors?.length) {
    throw new LoyaltyError("DISCOUNT_FAILED", payload.userErrors.map((e) => e.message).join("; "), 502);
  }
  if (!payload?.codeDiscountNode?.id) throw new LoyaltyError("DISCOUNT_FAILED", "Shopify did not return a discount.", 502);
  return { id: payload.codeDiscountNode.id };
}

export async function deleteDiscount(admin, discountNodeId) {
  await gql(
    admin,
    `#graphql
    mutation ClubDiscountDelete($id: ID!) {
      discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { message } }
    }`,
    { id: discountNodeId },
  );
}

/** Adds Shopify store credit to a customer (requires new customer accounts). */
export async function creditStoreCredit(admin, { customerId, amount, currencyCode, expiresAt }) {
  const data = await gql(
    admin,
    `#graphql
    mutation ClubStoreCredit($id: ID!, $input: StoreCreditAccountCreditInput!) {
      storeCreditAccountCredit(id: $id, creditInput: $input) {
        storeCreditAccountTransaction { id }
        userErrors { field message code }
      }
    }`,
    {
      id: customerGid(customerId),
      input: {
        creditAmount: { amount: String(amount), currencyCode },
        expiresAt: expiresAt ? expiresAt.toISOString() : undefined,
      },
    },
  );
  const payload = data.storeCreditAccountCredit;
  if (payload?.userErrors?.length) {
    throw new LoyaltyError("STORE_CREDIT_FAILED", payload.userErrors.map((e) => e.message).join("; "), 502);
  }
  return { id: payload?.storeCreditAccountTransaction?.id };
}

/**
 * Mirrors a member's loyalty state onto the Shopify customer: app-owned
 * metafields (for themes, segments, Klaviyo) and a `club-<tier>` tag.
 */
export async function syncCustomer(admin, member, tierName, tierNames = []) {
  const ownerId = customerGid(member.customerId);
  const metafields = [
    { key: "points_balance", type: "number_integer", value: String(member.balance) },
    { key: "points_pending", type: "number_integer", value: String(member.pending) },
    { key: "points_lifetime", type: "number_integer", value: String(member.lifetimeEarned) },
    { key: "tier", type: "single_line_text_field", value: tierName || "" },
    { key: "referral_code", type: "single_line_text_field", value: member.referralCode },
  ]
    .filter((m) => m.value !== "")
    .map((m) => ({ ...m, ownerId, namespace: "$app" }));

  await gql(
    admin,
    `#graphql
    mutation ClubSync($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    { metafields },
  );

  const wanted = tierName ? `club-${slug(tierName)}` : null;
  const stale = tierNames.map((n) => `club-${slug(n)}`).filter((t) => t !== wanted);
  if (stale.length) {
    await gql(
      admin,
      `#graphql
      mutation ClubTagsRemove($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { message } } }`,
      { id: ownerId, tags: stale },
    );
  }
  if (wanted) {
    await gql(
      admin,
      `#graphql
      mutation ClubTagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
      { id: ownerId, tags: [wanted, "club-member"] },
    );
  }
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** Public program config stored on the app installation so theme Liquid can read it (app.metafields.club.config). */
export async function publishStorefrontConfig(admin, config) {
  const data = await gql(admin, `#graphql
    query ClubInstallation { currentAppInstallation { id } }`);
  const ownerId = data.currentAppInstallation.id;
  await gql(
    admin,
    `#graphql
    mutation ClubConfig($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    { metafields: [{ ownerId, namespace: "club", key: "config", type: "json", value: JSON.stringify(config) }] },
  );
}

export async function emitFlowTrigger(admin, handle, payload) {
  const data = await gql(
    admin,
    `#graphql
    mutation ClubFlow($handle: String!, $payload: JSON!) {
      flowTriggerReceive(handle: $handle, payload: $payload) { userErrors { field message } }
    }`,
    { handle, payload },
  );
  const errors = data.flowTriggerReceive?.userErrors;
  if (errors?.length) throw new LoyaltyError("FLOW_ERROR", errors.map((e) => e.message).join("; "), 502);
}

/** Fulfilment and delivery dates for an order (used when webhooks miss a delivery update). */
export async function fetchOrderShipping(admin, orderId) {
  const data = await gql(
    admin,
    `#graphql
    query ClubOrderShipping($id: ID!) {
      order(id: $id) {
        id
        cancelledAt
        displayFulfillmentStatus
        fulfillments(first: 20) { createdAt deliveredAt status displayStatus }
      }
    }`,
    { id: `gid://shopify/Order/${orderId}` },
  );
  const order = data.order;
  if (!order) return null;
  const done = (order.fulfillments || []).filter((f) => f.status === "SUCCESS");
  const fulfilledAt = done.length ? new Date(Math.min(...done.map((f) => +new Date(f.createdAt)))) : null;
  const allDelivered = done.length > 0 && done.every((f) => f.deliveredAt || f.displayStatus === "DELIVERED");
  const deliveredAt = allDelivered
    ? new Date(Math.max(...done.map((f) => +new Date(f.deliveredAt || f.createdAt))))
    : null;
  return { cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null, fulfilledAt, deliveredAt };
}

/** Page through customers with lifetime spend, for retroactive credit. */
export async function fetchCustomersPage(admin, after) {
  const data = await gql(
    admin,
    `#graphql
    query ClubCustomers($after: String) {
      customers(first: 100, after: $after, query: "orders_count:>0") {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          firstName
          lastName
          defaultEmailAddress { emailAddress }
          numberOfOrders
          amountSpent { amount currencyCode }
          tags
        }
      }
    }`,
    { after: after || null },
  );
  return data.customers;
}
