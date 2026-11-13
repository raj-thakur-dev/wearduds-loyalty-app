import { useEffect } from "react";
import { useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { formatMoney, formatPoints } from "../loyalty/math";

export { formatMoney, formatPoints };

export function formatDate(value, withTime = false) {
  if (!value) return "—";
  const d = new Date(value);
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

/** Shows an App Bridge toast when an action returns `{ toast }` or `{ error }`. */
export function useActionToast(data) {
  const shopify = useAppBridge();
  useEffect(() => {
    if (!data) return;
    if (data.toast) shopify.toast.show(data.toast);
    if (data.error) shopify.toast.show(data.error, { isError: true });
  }, [data, shopify]);
}

export function useBusy() {
  const nav = useNavigation();
  return nav.state !== "idle";
}

/** Big-number tile used on the overview. */
export function Metric({ label, value, help }) {
  return (
    <s-box padding="base" background="base" borderRadius="base" border="base">
      <s-stack gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {help ? <s-text color="subdued">{help}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

export function FieldErrors({ errors }) {
  if (!errors || !Object.keys(errors).length) return null;
  return (
    <s-banner tone="critical" heading="Fix these fields">
      <s-unordered-list>
        {Object.entries(errors).map(([k, v]) => (
          <s-list-item key={k}>
            {k}: {v}
          </s-list-item>
        ))}
      </s-unordered-list>
    </s-banner>
  );
}

export const LEDGER_TONES = {
  PURCHASE: "success",
  REDEMPTION: "info",
  REFUND_REVERSAL: "warning",
  EXPIRY: "critical",
  ADJUSTMENT: "neutral",
};

export function ledgerTone(type, points) {
  return LEDGER_TONES[type] || (points >= 0 ? "success" : "neutral");
}
