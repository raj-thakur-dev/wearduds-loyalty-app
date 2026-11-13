import { webhookAction } from "../loyalty/webhook.server";
import { handleCustomerUpdate } from "../loyalty/actions.server";

export const action = webhookAction(({ shop, payload, admin }) => handleCustomerUpdate(shop, payload, admin));
