import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getSettings, updateSettings, validateEarnRule, validateSettingsInput } from "../loyalty/settings.server";
import { publishConfig } from "../loyalty/config.server";
import { FieldErrors, formatMoney, useActionToast, useBusy } from "../admin/ui";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const s = await getSettings(session.shop);
  return {
    rules: s.earnRules,
    base: {
      pointsPerCurrency: s.pointsPerCurrency,
      pointValue: s.pointValue,
      creditTrigger: s.creditTrigger,
      holdDays: s.holdDays,
      fallbackDays: s.fallbackDays,
      expiryDays: s.expiryDays,
      expiryWarningDays: s.expiryWarningDays,
      excludeTags: s.excludeTags.join(", "),
    },
    currency: s.currencyCode,
  };
}

const RULE_FIELDS = {
  purchase: [],
  signup: ["points"],
  birthdaySetup: ["points"],
  birthday: ["points", "daysBefore"],
  review: ["points", "minWords", "requireVerifiedBuyer"],
  photoReview: ["points"],
  referral: ["referrerPoints", "friendPoints", "monthlyCap"],
  instagram: ["points", "handle"],
  newsletter: ["points"],
};

export async function action({ request }) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const current = await getSettings(session.shop);

  const base = validateSettingsInput({
    pointsPerCurrency: form.get("pointsPerCurrency"),
    creditTrigger: form.get("creditTrigger"),
    holdDays: form.get("holdDays"),
    fallbackDays: form.get("fallbackDays"),
    expiryDays: form.get("expiryDays"),
    expiryWarningDays: form.get("expiryWarningDays"),
    excludeTags: form.get("excludeTags") ?? "",
  });
  if (base.errors) return { errors: base.errors };

  let rules = current.earnRules;
  for (const [key, fields] of Object.entries(RULE_FIELDS)) {
    const input = { enabled: form.get(`${key}.enabled`) === "on" };
    for (const f of fields) {
      if (f === "requireVerifiedBuyer") input[f] = form.get(`${key}.${f}`) === "on";
      else if (form.get(`${key}.${f}`) !== null) input[f] = form.get(`${key}.${f}`);
    }
    const res = validateEarnRule(key, input, rules);
    if (res.errors) return { errors: Object.fromEntries(Object.entries(res.errors).map(([f, m]) => [`${key}.${f}`, m])) };
    rules = res.data;
  }

  await updateSettings(session.shop, { ...base.data, earnRules: rules });
  await publishConfig(session.shop, admin).catch(() => null);
  return { toast: "Ways to earn saved" };
}

export default function Earn() {
  const { rules, base, currency } = useLoaderData();
  const result = useActionData();
  useActionToast(result);
  const busy = useBusy();
  const example = Math.floor(1999 * base.pointsPerCurrency);

  return (
    <s-page heading="Ways to earn">
      <Form method="post">
        <s-stack gap="base">
          <FieldErrors errors={result?.errors} />

          <s-section heading="Shopping">
            <s-stack gap="base">
              <s-switch name="purchase.enabled" label="Earn points on orders" checked={rules.purchase.enabled || undefined} />
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
                <s-number-field
                  name="pointsPerCurrency"
                  label="Points per ₹1 spent"
                  value={String(base.pointsPerCurrency)}
                  step="0.01"
                  min="0"
                  details={`A ${formatMoney(1999, currency)} order earns ${example.toLocaleString("en-IN")} points before tier bonus.`}
                />
                <s-select name="creditTrigger" label="Points unlock" value={base.creditTrigger}>
                  <s-option value="DELIVERED">After delivery</s-option>
                  <s-option value="FULFILLED">After shipping</s-option>
                  <s-option value="PAID">After payment</s-option>
                </s-select>
                <s-number-field name="holdDays" label="Wait (days)" value={String(base.holdDays)} min="0" max="90" details="Return window before points unlock" />
                <s-number-field
                  name="fallbackDays"
                  label="Unlock anyway after (days from shipping)"
                  value={String(base.fallbackDays)}
                  min="1"
                  max="120"
                  details="For couriers that never report delivery"
                />
              </s-grid>
              <s-paragraph color="subdued">
                Points are earned on what the customer paid for products, after discounts. Shipping, taxes added at checkout and gift cards don't earn.
              </s-paragraph>
            </s-stack>
          </s-section>

          <s-section heading="Account and profile">
            <s-stack gap="base">
              <RuleRow name="signup" rule={rules.signup} label="Welcome bonus on first sign-in" />
              <s-divider />
              <RuleRow name="birthdaySetup" rule={rules.birthdaySetup} label="Add a birthday (one time)" />
              <s-divider />
              <RuleRow name="birthday" rule={rules.birthday} label="Birthday gift (every year)">
                <s-number-field name="birthday.daysBefore" label="Days early" value={String(rules.birthday.daysBefore)} min="0" max="30" />
              </RuleRow>
              <s-divider />
              <RuleRow name="newsletter" rule={rules.newsletter} label="Subscribe to email marketing (one time)" />
            </s-stack>
          </s-section>

          <s-section heading="Reviews">
            <s-stack gap="base">
              <RuleRow name="review" rule={rules.review} label="Text review">
                <s-number-field name="review.minWords" label="Minimum words" value={String(rules.review.minWords)} min="0" />
                <s-checkbox name="review.requireVerifiedBuyer" label="Verified buyers only" checked={rules.review.requireVerifiedBuyer || undefined} />
              </RuleRow>
              <s-divider />
              <RuleRow name="photoReview" rule={rules.photoReview} label="Review with a photo (replaces the text amount)" />
              <s-paragraph color="subdued">Connect Judge.me under Settings &gt; Integrations so reviews earn automatically.</s-paragraph>
            </s-stack>
          </s-section>

          <s-section heading="Referrals">
            <s-stack gap="base">
              <s-switch name="referral.enabled" label="Refer a friend" checked={rules.referral.enabled || undefined} />
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
                <s-number-field name="referral.referrerPoints" label="Referrer gets" value={String(rules.referral.referrerPoints)} suffix="points" details="When the friend's first order ships" />
                <s-number-field name="referral.friendPoints" label="Friend gets" value={String(rules.referral.friendPoints)} suffix="points" details="When they join with the link" />
                <s-number-field name="referral.monthlyCap" label="Max rewarded referrals a month" value={String(rules.referral.monthlyCap)} min="0" details="0 = no limit" />
              </s-grid>
            </s-stack>
          </s-section>

          <s-section heading="Instagram">
            <s-stack gap="base">
              <RuleRow name="instagram" rule={rules.instagram} label="Follow on Instagram (verified)">
                <s-text-field name="instagram.handle" label="Handle" value={rules.instagram.handle} prefix="@" />
              </RuleRow>
              <s-banner tone="info">
                Members DM a one-time code to your account and the app checks they follow you before awarding points. Needs the Meta app keys in Settings &gt; Integrations.
              </s-banner>
            </s-stack>
          </s-section>

          <s-section heading="Expiry and exclusions">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
              <s-number-field name="expiryDays" label="Points expire after (days)" value={String(base.expiryDays)} min="0" details="0 = never expire" />
              <s-number-field name="expiryWarningDays" label="Warn this many days before" value={String(base.expiryWarningDays)} min="1" details="Sends the Club points expiring Flow trigger" />
              <s-text-field name="excludeTags" label="Exclude customers tagged" value={base.excludeTags} placeholder="staff, wholesale" details="Comma separated" />
            </s-grid>
          </s-section>

          <s-stack direction="inline" justifyContent="end">
            <s-button type="submit" variant="primary" loading={busy || undefined}>
              Save
            </s-button>
          </s-stack>
        </s-stack>
      </Form>
    </s-page>
  );
}

function RuleRow({ name, rule, label, children }) {
  return (
    <s-grid gridTemplateColumns="2fr 1fr" gap="base" alignItems="center">
      <s-switch name={`${name}.enabled`} label={label} checked={rule.enabled || undefined} />
      <s-number-field name={`${name}.points`} label="Points" labelAccessibilityVisibility="exclusive" value={String(rule.points)} min="0" suffix="points" />
      {children ? (
        <s-grid-item gridColumn="span 2">
          <s-stack direction="inline" gap="base" alignItems="end">
            {children}
          </s-stack>
        </s-grid-item>
      ) : null}
    </s-grid>
  );
}
