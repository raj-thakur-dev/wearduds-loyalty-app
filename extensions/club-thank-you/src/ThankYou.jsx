/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { callApp, pts } from "./api";

// Thank-you page: tell members what they'll earn; nudge guests to join.
export default async () => {
  render(<ThankYou />, document.body);
};

function ThankYou() {
  const [summary, setSummary] = useState(null);
  const subtotal = Number(shopify.cost?.subtotalAmount?.value?.amount || 0);

  useEffect(() => {
    callApp(`/api/checkout/summary?subtotal=${encodeURIComponent(subtotal)}`).then(setSummary).catch(() => setSummary(null));
  }, [subtotal]);

  if (!summary || !summary.live || summary.points <= 0) return null;

  const unlock = summary.creditTrigger === "DELIVERED" ? `${summary.holdDays} days after delivery` : "soon";
  if (summary.member) {
    return (
      <s-banner tone="success" heading={`You'll earn ${pts(summary.points)} Club Coins (₹${pts(summary.points)})`}>
        They unlock {unlock}. You now have {pts(summary.member.balance)} coins to spend
        {summary.member.pending ? ` and ${pts(summary.member.pending + summary.points)} on the way` : ""}.
      </s-banner>
    );
  }
  return (
    <s-banner heading={`This order earns ${pts(summary.points)} Club Coins (₹${pts(summary.points)})`}>
      Sign in with the email you used at checkout to claim them
      {summary.signupPoints ? `, plus ${pts(summary.signupPoints)} welcome coins` : ""}.
      <s-button slot="secondary-actions" href={`${(shopify.shop?.storefrontUrl || "").replace(/\/$/, "")}/account`}>
        Claim coins
      </s-button>
    </s-banner>
  );
}
