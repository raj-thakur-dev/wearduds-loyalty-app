import { vi } from "vitest";

/** A fake Admin GraphQL client that records calls and answers like Shopify. */
export function createFakeAdmin() {
  const calls = [];
  const state = { failDiscount: false, delivery: {} };
  const admin = {
    calls,
    state,
    async graphql(query, { variables } = {}) {
      const name = (query.match(/(mutation|query)\s+(\w+)/) || [])[2];
      calls.push({ name, variables });
      const json = (data) => ({ json: async () => ({ data }) });
      switch (name) {
        case "ClubDiscount":
          if (state.failDiscount) {
            return json({ discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ message: "Code taken" }] } });
          }
          return json({ discountCodeBasicCreate: { codeDiscountNode: { id: `gid://shopify/DiscountCodeNode/${calls.length}` }, userErrors: [] } });
        case "ClubFreeShipping":
          return json({ discountCodeFreeShippingCreate: { codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/fs" }, userErrors: [] } });
        case "ClubSync":
        case "ClubConfig":
          return json({ metafieldsSet: { userErrors: [] } });
        case "ClubTagsAdd":
          return json({ tagsAdd: { userErrors: [] } });
        case "ClubTagsRemove":
          return json({ tagsRemove: { userErrors: [] } });
        case "ClubFlow":
          return json({ flowTriggerReceive: { userErrors: [] } });
        case "ClubInstallation":
          return json({ currentAppInstallation: { id: "gid://shopify/AppInstallation/1" } });
        case "ClubOrderShipping": {
          const id = variables.id.split("/").pop();
          const d = state.delivery[id];
          return json({
            order: {
              id: variables.id,
              cancelledAt: null,
              displayFulfillmentStatus: d ? "FULFILLED" : "UNFULFILLED",
              fulfillments: d ? [{ createdAt: d.fulfilledAt, deliveredAt: d.deliveredAt || null, status: "SUCCESS", displayStatus: d.deliveredAt ? "DELIVERED" : "IN_TRANSIT" }] : [],
            },
          });
        }
        case "ClubStoreCredit":
          return json({ storeCreditAccountCredit: { storeCreditAccountTransaction: { id: "gid://shopify/StoreCreditAccountCreditTransaction/1" }, userErrors: [] } });
        default:
          throw new Error(`Unexpected GraphQL call ${name}`);
      }
    },
  };
  return admin;
}

export const fakeAdmin = createFakeAdmin();

vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: async () => ({ admin: fakeAdmin }) },
  authenticate: {},
}));

export async function resetDb(prisma) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "LedgerEntry","Redemption","LoyaltyOrder","Referral","Member","Reward","Tier","ProgramSettings","JobRun" CASCADE',
  );
}

let orderSeq = 1000;
export function orderPayload({ customerId, amount, name, codes = [], tags = "", refCode } = {}) {
  const id = ++orderSeq;
  return {
    id,
    name: name || `#WD${id}`,
    processed_at: new Date().toISOString(),
    email: `c${customerId}@example.com`,
    customer: { id: customerId, email: `c${customerId}@example.com`, first_name: `Cust${customerId}`, tags },
    line_items: [{ price: String(amount), quantity: 1, discount_allocations: [] }],
    current_total_price: String(amount),
    discount_codes: codes.map((code) => ({ code })),
    note_attributes: refCode ? [{ name: "_club_ref", value: refCode }] : [],
  };
}

/** balance must always equal the sum of `remaining` on available credits. */
export async function assertInvariant(prisma, memberId, expect) {
  const member = await prisma.member.findUniqueOrThrow({ where: { id: memberId } });
  const agg = await prisma.ledgerEntry.aggregate({
    where: { memberId, status: "AVAILABLE", remaining: { gt: 0 } },
    _sum: { remaining: true },
  });
  const pending = await prisma.ledgerEntry.aggregate({ where: { memberId, status: "PENDING" }, _sum: { points: true } });
  expect(member.balance).toBe(agg._sum.remaining || 0);
  expect(member.pending).toBe(pending._sum.points || 0);
  expect(member.balance).toBeGreaterThanOrEqual(0);
  return member;
}
