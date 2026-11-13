import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings, updateSettings, validateSettingsInput } from "../loyalty/settings.server";
import { publishConfig } from "../loyalty/config.server";
import { minimumSubtotalFor } from "../loyalty/math";
import { FieldErrors, formatMoney, formatPoints, useActionToast, useBusy } from "../admin/ui";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [s, rewards, tiers, usage, tierCounts] = await Promise.all([
    getSettings(shop),
    prisma.reward.findMany({ where: { shop }, orderBy: [{ sortOrder: "asc" }, { pointsCost: "asc" }], include: { minTier: true } }),
    prisma.tier.findMany({ where: { shop }, orderBy: { threshold: "asc" } }),
    prisma.redemption.groupBy({ by: ["rewardId"], where: { shop, status: { in: ["ISSUED", "USED"] } }, _count: true }),
    prisma.member.groupBy({ by: ["tierId"], where: { shop }, _count: true }),
  ]);
  return {
    currency: s.currencyCode,
    redeem: {
      pointValue: s.pointValue,
      maxRedeemPercent: s.maxRedeemPercent,
      sliderEnabled: s.sliderEnabled,
      sliderStep: s.sliderStep,
      sliderMinPoints: s.sliderMinPoints,
      codeExpiryDays: s.codeExpiryDays,
      codePrefix: s.codePrefix,
      combinesWithProduct: s.combinesWithProduct,
      combinesWithOrder: s.combinesWithOrder,
      combinesWithShipping: s.combinesWithShipping,
      storeCreditEnabled: s.storeCreditEnabled,
      restorePointsOnCancel: s.restorePointsOnCancel,
    },
    rewards: rewards.map((r) => ({
      ...r,
      minTierName: r.minTier?.name || null,
      effectiveMin: r.type === "FIXED_AMOUNT" ? minimumSubtotalFor(r.value, s.maxRedeemPercent, r.minSubtotal) : r.minSubtotal,
      used: usage.find((u) => u.rewardId === r.id)?._count || 0,
    })),
    tiers: tiers.map((t) => ({ ...t, members: tierCounts.find((c) => c.tierId === t.id)?._count || 0 })),
  };
}

function parseReward(form, maxPercent) {
  const errors = {};
  const title = String(form.get("title") || "").trim();
  const type = String(form.get("type"));
  const pointsCost = Number.parseInt(form.get("pointsCost"), 10);
  const value = Number.parseFloat(form.get("value") || "0");
  const minRaw = form.get("minSubtotal");
  const minSubtotal = minRaw === null || minRaw === "" ? null : Number.parseFloat(minRaw);
  const minTierId = form.get("minTierId") || null;
  if (!title || title.length > 60) errors.title = "Give the reward a short name.";
  if (!["FIXED_AMOUNT", "PERCENTAGE", "FREE_SHIPPING"].includes(type)) errors.type = "Pick a reward type.";
  if (!(pointsCost > 0)) errors.pointsCost = "Points must be above 0.";
  if (type === "FIXED_AMOUNT" && !(value > 0)) errors.value = "Enter the ₹ amount off.";
  if (type === "PERCENTAGE" && !(value > 0 && value <= maxPercent)) errors.value = `Percentage must be 1 to ${maxPercent} (your max redeem %).`;
  if (minSubtotal !== null && !(minSubtotal >= 0)) errors.minSubtotal = "Minimum order can't be negative.";
  if (Object.keys(errors).length) return { errors };
  return {
    data: {
      title,
      type,
      pointsCost,
      value: type === "FREE_SHIPPING" ? 0 : value,
      minSubtotal,
      minTierId,
      active: form.get("active") === "on",
    },
  };
}

export async function action({ request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");
  const settings = await getSettings(shop);
  const publish = () => publishConfig(shop, admin).catch(() => null);

  switch (intent) {
    case "save-redeem": {
      const res = validateSettingsInput({
        pointValue: form.get("pointValue"),
        maxRedeemPercent: form.get("maxRedeemPercent"),
        sliderEnabled: form.get("sliderEnabled") === "on",
        sliderStep: form.get("sliderStep"),
        sliderMinPoints: form.get("sliderMinPoints"),
        codeExpiryDays: form.get("codeExpiryDays"),
        codePrefix: form.get("codePrefix"),
        combinesWithProduct: form.get("combinesWithProduct") === "on",
        combinesWithOrder: form.get("combinesWithOrder") === "on",
        combinesWithShipping: form.get("combinesWithShipping") === "on",
        storeCreditEnabled: form.get("storeCreditEnabled") === "on",
        restorePointsOnCancel: form.get("restorePointsOnCancel") === "on",
      });
      if (res.errors) return { errors: res.errors };
      await updateSettings(shop, res.data);
      await publish();
      return { toast: "Redemption rules saved" };
    }
    case "save-reward": {
      const res = parseReward(form, settings.maxRedeemPercent);
      if (res.errors) return { errors: res.errors };
      const id = form.get("id");
      if (id) {
        await prisma.reward.updateMany({ where: { id: String(id), shop }, data: res.data });
      } else {
        const count = await prisma.reward.count({ where: { shop } });
        await prisma.reward.create({ data: { ...res.data, shop, sortOrder: count } });
      }
      await publish();
      return { toast: "Reward saved" };
    }
    case "delete-reward": {
      const id = String(form.get("id"));
      const used = await prisma.redemption.count({ where: { rewardId: id } });
      if (used > 0) {
        await prisma.reward.updateMany({ where: { id, shop }, data: { active: false } });
        await publish();
        return { toast: "Reward has history, so it was turned off instead of deleted" };
      }
      await prisma.reward.deleteMany({ where: { id, shop } });
      await publish();
      return { toast: "Reward deleted" };
    }
    case "save-tier": {
      const id = form.get("id");
      const name = String(form.get("name") || "").trim();
      const threshold = Number.parseInt(form.get("threshold"), 10);
      const multiplier = Number.parseFloat(form.get("multiplier"));
      const color = String(form.get("color") || "#111111");
      const perks = String(form.get("perks") || "")
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 10);
      const errors = {};
      if (!name || name.length > 30) errors.name = "Name the tier (max 30 characters).";
      if (!(threshold >= 0)) errors.threshold = "Threshold must be 0 or more.";
      if (!(multiplier >= 1 && multiplier <= 10)) errors.multiplier = "Multiplier must be 1 to 10.";
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) errors.color = "Use a hex colour like #E0A100.";
      const tiers = await prisma.tier.findMany({ where: { shop } });
      const others = tiers.filter((t) => t.id !== id);
      if (others.some((t) => t.threshold === threshold)) errors.threshold = "Another tier already starts at that number.";
      if (others.some((t) => t.name.toLowerCase() === name.toLowerCase())) errors.name = "Another tier has that name.";
      const editingBase = id && tiers.find((t) => t.id === id)?.threshold === 0;
      if (editingBase && threshold !== 0) errors.threshold = "The entry tier must start at 0.";
      if (Object.keys(errors).length) return { errors };
      const data = { name, threshold, multiplier, color, perks };
      if (id) await prisma.tier.updateMany({ where: { id: String(id), shop }, data });
      else await prisma.tier.create({ data: { ...data, shop, sortOrder: tiers.length } });
      await publish();
      return { toast: "Tier saved. Members move up as they next earn points." };
    }
    case "delete-tier": {
      const id = String(form.get("id"));
      const tier = await prisma.tier.findFirst({ where: { id, shop } });
      if (!tier) return { error: "Tier not found" };
      if (tier.threshold === 0) return { error: "The entry tier can't be deleted." };
      const below = await prisma.tier.findFirst({ where: { shop, threshold: { lt: tier.threshold } }, orderBy: { threshold: "desc" } });
      await prisma.$transaction([
        prisma.member.updateMany({ where: { shop, tierId: id }, data: { tierId: below?.id ?? null } }),
        prisma.tier.delete({ where: { id } }),
      ]);
      await publish();
      return { toast: `Tier deleted. Its members moved to ${below?.name || "no tier"}.` };
    }
    default:
      return { error: "Unknown action" };
  }
}

const TYPE_LABEL = { FIXED_AMOUNT: "₹ off", PERCENTAGE: "% off", FREE_SHIPPING: "Free shipping" };

export default function Rewards() {
  const { redeem, rewards, tiers, currency } = useLoaderData();
  const result = useActionData();
  useActionToast(result);
  const busy = useBusy();
  const per100 = formatMoney(redeem.pointValue * 100, currency);

  return (
    <s-page heading="Rewards & tiers">
      <s-button slot="primary-action" variant="primary" commandFor="reward-new" command="--show">
        Add reward
      </s-button>
      <FieldErrors errors={result?.errors} />

      <s-section heading="Rewards">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Reward</s-table-header>
            <s-table-header format="numeric">Points</s-table-header>
            <s-table-header>Min. order</s-table-header>
            <s-table-header>Who</s-table-header>
            <s-table-header format="numeric">Redeemed</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rewards.map((r) => (
              <s-table-row key={r.id}>
                <s-table-cell>
                  <s-stack gap="small-500">
                    <s-text type="strong">{r.title}</s-text>
                    <s-text color="subdued">{TYPE_LABEL[r.type]}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{formatPoints(r.pointsCost)}</s-table-cell>
                <s-table-cell>{r.effectiveMin ? formatMoney(r.effectiveMin, currency) : "None"}</s-table-cell>
                <s-table-cell>{r.minTierName ? `${r.minTierName}+` : "Everyone"}</s-table-cell>
                <s-table-cell>{formatPoints(r.used)}</s-table-cell>
                <s-table-cell>
                  <s-badge tone={r.active ? "success" : "neutral"}>{r.active ? "Active" : "Off"}</s-badge>
                </s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="small">
                    <s-button variant="tertiary" commandFor={`reward-${r.id}`} command="--show">
                      Edit
                    </s-button>
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete-reward" />
                      <input type="hidden" name="id" value={r.id} />
                      <s-button type="submit" variant="tertiary" tone="critical" accessibilityLabel={`Delete ${r.title}`}>
                        Delete
                      </s-button>
                    </Form>
                  </s-stack>
                  <RewardModal id={`reward-${r.id}`} reward={r} tiers={tiers} busy={busy} />
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        <RewardModal id="reward-new" tiers={tiers} busy={busy} />
      </s-section>

      <s-section heading="Redemption rules">
        <Form method="post">
          <input type="hidden" name="intent" value="save-redeem" />
          <s-stack gap="base">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
              <s-number-field name="pointValue" label="Value of 1 point (₹)" value={String(redeem.pointValue)} step="0.01" min="0.001" details={`100 points = ${per100}`} />
              <s-number-field name="maxRedeemPercent" label="Max % of an order paid with points" value={String(redeem.maxRedeemPercent)} min="1" max="100" suffix="%" details="Sets each reward's minimum order" />
              <s-number-field name="codeExpiryDays" label="Codes expire after (days)" value={String(redeem.codeExpiryDays)} min="1" />
              <s-text-field name="codePrefix" label="Code prefix" value={redeem.codePrefix} details="e.g. WD-7K3PQ2XA" />
            </s-grid>
            <s-divider />
            <s-switch name="sliderEnabled" label="Let members choose how many points to use in the cart" checked={redeem.sliderEnabled || undefined} />
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
              <s-number-field name="sliderStep" label="Slider step (points)" value={String(redeem.sliderStep)} min="1" />
              <s-number-field name="sliderMinPoints" label="Minimum points per redemption" value={String(redeem.sliderMinPoints)} min="0" />
            </s-grid>
            <s-divider />
            <s-text type="strong">Reward codes combine with</s-text>
            <s-stack direction="inline" gap="large">
              <s-checkbox name="combinesWithProduct" label="Product discounts" checked={redeem.combinesWithProduct || undefined} />
              <s-checkbox name="combinesWithOrder" label="Order discounts (e.g. WEAR20)" checked={redeem.combinesWithOrder || undefined} />
              <s-checkbox name="combinesWithShipping" label="Shipping discounts" checked={redeem.combinesWithShipping || undefined} />
            </s-stack>
            <s-divider />
            <s-switch name="restorePointsOnCancel" label="Give points back if an order using a reward is cancelled" checked={redeem.restorePointsOnCancel || undefined} />
            <s-switch
              name="storeCreditEnabled"
              label="Offer Shopify store credit as a redemption option"
              details="Only works with Shopify checkout and new customer accounts. Leave off if you use GoKwik, Shopflo or Razorpay Magic Checkout."
              checked={redeem.storeCreditEnabled || undefined}
            />
            <s-stack direction="inline" justifyContent="end">
              <s-button type="submit" variant="primary" loading={busy || undefined}>
                Save rules
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Tiers">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Tiers are based on all the points a member has ever earned, so spending points never drops them. After a year without an order a member
            drops to the tier their last year's points earn.
          </s-paragraph>
          {tiers.map((t) => (
            <TierForm key={t.id} tier={t} busy={busy} />
          ))}
          <s-button commandFor="tier-new" command="--show">
            Add tier
          </s-button>
          <Form method="post">
            <input type="hidden" name="intent" value="save-tier" />
            <s-modal id="tier-new" heading="New tier">
              <TierFields tier={{ name: "", threshold: "", multiplier: 1, color: "#111111", perks: [] }} />
              <s-button slot="primary-action" variant="primary" type="submit" commandFor="tier-new" command="--hide">
                Add tier
              </s-button>
              <s-button slot="secondary-actions" commandFor="tier-new" command="--hide">
                Cancel
              </s-button>
            </s-modal>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function RewardModal({ id, reward, tiers, busy }) {
  const r = reward || { title: "", type: "FIXED_AMOUNT", pointsCost: "", value: "", minSubtotal: "", minTierId: "", active: true };
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="save-reward" />
      {reward ? <input type="hidden" name="id" value={reward.id} /> : null}
      <s-modal id={id} heading={reward ? `Edit ${reward.title}` : "New reward"}>
        <s-stack gap="base">
          <s-text-field name="title" label="Name customers see" value={r.title} placeholder="₹100 off" required />
          <s-select name="type" label="Type" value={r.type}>
            <s-option value="FIXED_AMOUNT">₹ off the order</s-option>
            <s-option value="PERCENTAGE">% off the order</s-option>
            <s-option value="FREE_SHIPPING">Free shipping</s-option>
          </s-select>
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-number-field name="pointsCost" label="Points needed" value={String(r.pointsCost)} min="1" required />
            <s-number-field name="value" label="Amount (₹ or %)" value={String(r.value ?? "")} min="0" details="Not used for free shipping" />
          </s-grid>
          <s-number-field
            name="minSubtotal"
            label="Minimum order (₹)"
            value={r.minSubtotal === null ? "" : String(r.minSubtotal)}
            min="0"
            details="Leave blank to use the max % rule automatically"
          />
          <s-select name="minTierId" label="Available to" value={r.minTierId || ""}>
            <s-option value="">All members</s-option>
            {tiers.map((t) => (
              <s-option key={t.id} value={t.id}>
                {t.name} and above
              </s-option>
            ))}
          </s-select>
          <s-switch name="active" label="Active" checked={r.active || undefined} />
        </s-stack>
        <s-button slot="primary-action" variant="primary" type="submit" loading={busy || undefined} commandFor={id} command="--hide">
          Save reward
        </s-button>
        <s-button slot="secondary-actions" commandFor={id} command="--hide">
          Cancel
        </s-button>
      </s-modal>
    </Form>
  );
}

function TierFields({ tier }) {
  return (
    <s-stack gap="base">
      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))" gap="base">
        <s-text-field name="name" label="Name" value={tier.name} required />
        <s-number-field name="threshold" label="Starts at (lifetime points)" value={String(tier.threshold)} min="0" required />
        <s-number-field name="multiplier" label="Points multiplier" value={String(tier.multiplier)} step="0.05" min="1" max="10" suffix="x" />
        <s-color-field name="color" label="Badge colour" value={tier.color} />
      </s-grid>
      <s-text-area name="perks" label="Perks (one per line)" value={(tier.perks || []).join("\n")} rows={4} />
    </s-stack>
  );
}

function TierForm({ tier, busy }) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="base">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-stack direction="inline" gap="small" alignItems="center">
            <span style={{ width: 12, height: 12, borderRadius: 6, background: tier.color, display: "inline-block" }} />
            <s-heading>{tier.name}</s-heading>
            <s-badge>{formatPoints(tier.members)} members</s-badge>
          </s-stack>
          {tier.threshold !== 0 ? (
            <Form method="post">
              <input type="hidden" name="intent" value="delete-tier" />
              <input type="hidden" name="id" value={tier.id} />
              <s-button type="submit" variant="tertiary" tone="critical">
                Delete
              </s-button>
            </Form>
          ) : null}
        </s-stack>
        <Form method="post">
          <input type="hidden" name="intent" value="save-tier" />
          <input type="hidden" name="id" value={tier.id} />
          <s-stack gap="base">
            <TierFields tier={tier} />
            <s-stack direction="inline" justifyContent="end">
              <s-button type="submit" loading={busy || undefined}>
                Save {tier.name}
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-stack>
    </s-box>
  );
}
