import { webhookAction } from "../loyalty/webhook.server";
import { handleRefund } from "../loyalty/orders.server";

export const action = webhookAction(({ shop, payload, admin }) => handleRefund(shop, payload, admin));
