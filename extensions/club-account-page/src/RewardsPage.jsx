/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { callApp, date, money, pts } from "./api";

// Rewards page in new customer accounts (customer-account.page.render).
// Merchants add it to the account menu in the checkout & accounts editor.
export default async () => {
  render(<RewardsPage />, document.body);
};

function RewardsPage() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);

  const load = () =>
    callApp("/api/customer/state")
      .then((s) => {
        setState(s);
        setError(null);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  if (error && !state) {
    return (
      <s-page heading="Rewards">
        <s-banner tone="critical" heading="Rewards couldn't load">
          {error}
          <s-button slot="secondary-actions" onClick={load}>
            Try again
          </s-button>
        </s-banner>
      </s-page>
    );
  }
  if (!state) {
    return (
      <s-page heading="Rewards">
        <s-section>
          <s-skeleton-paragraph />
          <s-skeleton-paragraph />
        </s-section>
      </s-page>
    );
  }

  const { program, member } = state;
  if (!member) {
    return (
      <s-page heading={program.name}>
        <s-section>
          <s-paragraph>The club opens soon. Check back after launch to start earning points on every order.</s-paragraph>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading={program.name} subheading={member.tier ? `${member.tier.name} member` : undefined}>
      <s-section heading="Your balance">
        <s-stack gap="base">
          <s-heading>{member.worthLabel} to spend</s-heading>
          <s-text>
            {pts(member.balance)} points
            {member.pending ? `, plus ${pts(member.pending)} unlocking after delivery` : ""}
          </s-text>
          {member.nextTier ? (
            <s-text color="subdued">
              {pts(member.nextTier.pointsNeeded)} points to {member.nextTier.name} ({member.nextTier.multiplier}x points on every order)
            </s-text>
          ) : null}
          {member.nextExpiry ? (
            <s-text color="subdued">
              {pts(member.nextExpiry.points)} points expire on {date(member.nextExpiry.date)}.
            </s-text>
          ) : null}
        </s-stack>
      </s-section>

      {state.codes.length ? (
        <s-section heading="Your codes">
          <s-stack gap="base">
            {state.codes.map((c) => (
              <CodeRow key={c.code} code={c} />
            ))}
          </s-stack>
        </s-section>
      ) : null}

      <s-section heading="Rewards">
        <s-stack gap="base">
          {state.rewards.map((r) => (
            <RewardRow key={r.id} reward={r} onRedeemed={load} />
          ))}
          <s-text color="subdued">
            100 points = {money(program.pointValue * 100)}. Points can pay for up to {program.maxRedeemPercent}% of an order.
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Earn more">
        <s-stack gap="base">
          {state.earn.map((e) => (
            <s-stack key={e.key} direction="inline" justifyContent="space-between" alignItems="center" gap="base">
              <s-stack gap="none">
                <s-text type="strong">{e.title}</s-text>
                {e.detail ? <s-text color="subdued">{e.detail}</s-text> : null}
              </s-stack>
              {e.status === "done" ? <s-badge tone="success">Done</s-badge> : e.points ? <s-text type="strong">+{pts(e.points)}</s-text> : null}
            </s-stack>
          ))}
          {!member.birthdaySet ? <BirthdayForm onSaved={load} /> : null}
          <ReferralLink code={member.referral.code} />
        </s-stack>
      </s-section>

      <s-section heading="Points history">
        {state.history.length === 0 ? (
          <s-paragraph>Nothing yet. Your first order starts the count.</s-paragraph>
        ) : (
          <s-stack gap="small">
            {state.history.map((e) => (
              <s-stack key={e.id} direction="inline" justifyContent="space-between" gap="base">
                <s-stack gap="none">
                  <s-text>{e.description}</s-text>
                  <s-text color="subdued">
                    {date(e.date)}
                    {e.pending ? ", unlocks after delivery" : ""}
                  </s-text>
                </s-stack>
                <s-text type="strong">{(e.points > 0 ? "+" : "") + pts(e.points)}</s-text>
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

function CodeRow({ code }) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
        <s-stack gap="none">
          <s-text type="strong">{code.code}</s-text>
          <s-text color="subdued">
            {code.label}
            {code.minSubtotal ? ` on orders over ${money(code.minSubtotal)}` : ""}. Use by {date(code.expiresAt)}
          </s-text>
        </s-stack>
        <s-button href={`shopify:storefront${code.applyUrl}`}>Use now</s-button>
      </s-stack>
    </s-box>
  );
}

function RewardRow({ reward, onRedeemed }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [issued, setIssued] = useState(null);

  const redeem = () => {
    setBusy(true);
    setError(null);
    callApp("/api/customer/action/redeem", { method: "POST", body: { rewardId: reward.id } })
      .then((res) => {
        setIssued(res);
        setConfirming(false);
        onRedeemed();
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const meta = `${pts(reward.points)} points${reward.minSubtotal ? `, orders over ${money(reward.minSubtotal)}` : ""}`;
  return (
    <s-stack gap="small">
      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
        <s-stack gap="none">
          <s-text type="strong">{reward.title}</s-text>
          <s-text color="subdued">{meta}</s-text>
        </s-stack>
        {reward.canRedeem ? (
          <s-button onClick={() => setConfirming(true)} disabled={confirming || undefined}>
            Get code
          </s-button>
        ) : (
          <s-text color="subdued">{reward.tierLocked ? `Unlocks at ${reward.minTier}` : `${pts(reward.pointsNeeded)} to go`}</s-text>
        )}
      </s-stack>
      {confirming ? (
        <s-banner heading={`Spend ${pts(reward.points)} points on ${reward.title}?`}>
          You'll get a code for your next order.
          <s-button slot="secondary-actions" variant="primary" loading={busy || undefined} onClick={redeem}>
            Spend points
          </s-button>
          <s-button slot="secondary-actions" onClick={() => setConfirming(false)}>
            Keep them
          </s-button>
        </s-banner>
      ) : null}
      {issued ? (
        <s-banner tone="success" heading={`Your code: ${issued.code}`}>
          {issued.label}
          {issued.minSubtotal ? ` on orders over ${money(issued.minSubtotal)}` : ""}.
          <s-button slot="secondary-actions" href={`shopify:storefront${issued.applyUrl}`}>
            Use now
          </s-button>
        </s-banner>
      ) : null}
      {error ? <s-banner tone="critical">{error}</s-banner> : null}
    </s-stack>
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function BirthdayForm({ onSaved }) {
  const [month, setMonth] = useState("");
  const [day, setDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = () => {
    if (!month || !day) return setError("Pick a month and a day.");
    setBusy(true);
    callApp("/api/customer/action/birthday", { method: "POST", body: { month, day } })
      .then(onSaved)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <s-stack gap="small">
      <s-stack direction="inline" gap="base" alignItems="end">
        <s-select label="Birthday month" value={month} onChange={(e) => setMonth(e.currentTarget.value)}>
          {MONTHS.map((m, i) => (
            <s-option key={m} value={String(i + 1)}>
              {m}
            </s-option>
          ))}
        </s-select>
        <s-select label="Day" value={day} onChange={(e) => setDay(e.currentTarget.value)}>
          {Array.from({ length: 31 }, (_, i) => (
            <s-option key={i} value={String(i + 1)}>
              {String(i + 1)}
            </s-option>
          ))}
        </s-select>
        <s-button loading={busy || undefined} onClick={save}>
          Save birthday
        </s-button>
      </s-stack>
      {error ? <s-text tone="critical">{error}</s-text> : null}
    </s-stack>
  );
}

function ReferralLink({ code }) {
  const url = `${shopify.shop.storefrontUrl.replace(/\/$/, "")}/?ref=${encodeURIComponent(code)}`;
  return (
    <s-stack gap="small">
      <s-text type="strong">Your referral link</s-text>
      <s-text-field label="Referral link" labelAccessibilityVisibility="exclusive" value={url} readOnly />
      <s-button href={`https://wa.me/?text=${encodeURIComponent(`Join the Wearduds Club with my link and get points off your first order: ${url}`)}`} target="_blank">
        Send on WhatsApp
      </s-button>
    </s-stack>
  );
}
