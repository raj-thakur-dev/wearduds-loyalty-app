/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { callApp, date, pts } from "./api";

// "Coins for this order" on the order status page in customer accounts.
export default async () => {
  render(<OrderPoints />, document.body);
};

function OrderPoints() {
  const [order, setOrder] = useState(undefined);
  const orderId = shopify.order?.value?.id;

  useEffect(() => {
    if (!orderId) return setOrder(null);
    callApp(`/api/customer/order?order=${encodeURIComponent(orderId)}`)
      .then((res) => setOrder(res.order))
      .catch(() => setOrder(null));
  }, [orderId]);

  if (!order || order.points <= 0) return null;

  let message;
  if (order.status === "CREDITED") message = `${pts(order.points)} coins (₹${pts(order.points)}) earned on this order.`;
  else if (order.status === "CANCELLED") return null;
  else if (order.releaseAt) message = `${pts(order.points)} coins unlock on ${date(order.releaseAt)}, once the return window closes.`;
  else message = `${pts(order.points)} coins unlock after this order is delivered.`;

  return (
    <s-section heading="Club Coins">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-badge tone={order.status === "CREDITED" ? "success" : "info"}>{order.status === "CREDITED" ? "Earned" : "Pending"}</s-badge>
        <s-text>{message}</s-text>
      </s-stack>
    </s-section>
  );
}
