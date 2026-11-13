import { webhookAction } from "../loyalty/webhook.server";
import { handleFulfillment } from "../loyalty/orders.server";

// fulfillments/create and fulfillments/update share this endpoint.
export const action = webhookAction(({ shop, payload, admin }) => handleFulfillment(shop, payload, admin));
