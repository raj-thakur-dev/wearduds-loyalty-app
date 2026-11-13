// Generates realistic storefront payloads for the visual harness (not part of CI assertions).
import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { fakeAdmin, resetDb, orderPayload } from "./helpers";
import prisma from "../app/db.server";
import { getSettings, updateSettings } from "../app/loyalty/settings.server";
import { handleFulfillment, handleOrderPaid, releaseDueOrders } from "../app/loyalty/orders.server";
import { redeem } from "../app/loyalty/redeem.server";
import { findMember } from "../app/loyalty/members.server";
import { buildState } from "../app/loyalty/storefront.server";

const SHOP = "wearduds-fixture.myshopify.com";
it.skipIf(!process.env.WRITE_FIXTURES)("writes fixtures", async () => {
  await resetDb(prisma);
  await getSettings(SHOP);
  await updateSettings(SHOP, { isLive: true });
  const o = orderPayload({ customerId: 501, amount: 3499, name: "#WD2041" });
  o.customer.first_name = "Arjun";
  await handleOrderPaid(SHOP, o, fakeAdmin);
  fakeAdmin.state.delivery[o.id] = { fulfilledAt: new Date().toISOString(), deliveredAt: new Date().toISOString() };
  await handleFulfillment(SHOP, { order_id: o.id, status: "success" }, fakeAdmin);
  await releaseDueOrders(SHOP, new Date(Date.now() + 9 * 86400000));
  const o2 = orderPayload({ customerId: 501, amount: 1299, name: "#WD2089" });
  o2.customer.first_name = "Arjun";
  await handleOrderPaid(SHOP, o2, fakeAdmin);
  const m = await findMember(SHOP, 501);
  const reward = await prisma.reward.findFirst({ where: { shop: SHOP, pointsCost: 500 } });
  await redeem(SHOP, m.id, { rewardId: reward.id }, fakeAdmin);
  const member = await buildState(SHOP, 501, { cartSubtotal: 2499 });
  const guest = await buildState(SHOP, null, { cartSubtotal: 2499 });
  writeFileSync("/tmp/harness/state-member.json", JSON.stringify(member, null, 2));
  writeFileSync("/tmp/harness/state-guest.json", JSON.stringify(guest, null, 2));
});
