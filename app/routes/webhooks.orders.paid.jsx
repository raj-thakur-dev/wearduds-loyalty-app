import { webhookAction } from "../loyalty/webhook.server";
import { handleOrderPaid } from "../loyalty/orders.server";

export const action = webhookAction(({ shop, payload, admin }) => handleOrderPaid(shop, payload, admin));
