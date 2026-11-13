import { webhookAction } from "../loyalty/webhook.server";
import { handleOrderCancelled } from "../loyalty/orders.server";

export const action = webhookAction(({ shop, payload, admin }) => handleOrderCancelled(shop, payload, admin));
