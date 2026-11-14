/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { callApp, pts } from "./api";

// Compact club card on the customer account Profile page.
export default async () => {
  render(<ProfileCard />, document.body);
};

function ProfileCard() {
  const [state, setState] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    callApp("/api/customer/state").then(setState).catch(() => setFailed(true));
  }, []);

  if (failed) return null;
  if (!state) {
    return (
      <s-section>
        <s-skeleton-paragraph />
      </s-section>
    );
  }
  const m = state.member;
  if (!m) return null;

  return (
    <s-section heading={state.program.name}>
      <s-stack gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-heading>{m.worthLabel} to spend</s-heading>
          {m.tier ? <s-badge>{m.tier.name}</s-badge> : null}
        </s-stack>
        <s-text color="subdued">
          {pts(m.balance)} points{m.pending ? `, ${pts(m.pending)} pending` : ""}
          {m.nextTier ? `. ${pts(m.nextTier.pointsNeeded)} to ${m.nextTier.name}` : ""}
        </s-text>
        <s-link href="extension:club-account-page/">See rewards</s-link>
      </s-stack>
    </s-section>
  );
}
