import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { adjustPoints } from "../loyalty/actions.server";
import { LoyaltyError, restoreDebit, setTier, withMemberLock } from "../loyalty/ledger.server";
import { getSettings } from "../loyalty/settings.server";
import { deleteDiscount } from "../loyalty/shopify-api.server";
import { runEffects } from "../loyalty/effects.server";
import { nextTierProgress, pointsToMoney } from "../loyalty/math";
import { LEDGER_LABELS } from "../loyalty/defaults";
import { formatDate, formatMoney, formatPoints, ledgerTone, useActionToast, useBusy } from "../admin/ui";

export async function loader({ request, params }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const member = await prisma.member.findFirst({ where: { id: params.id, shop }, include: { tier: true, referredBy: true } });
  if (!member) throw new Response("Member not found", { status: 404 });

  const [settings, tiers, ledger, redemptions, orders, referrals] = await Promise.all([
    getSettings(shop),
    prisma.tier.findMany({ where: { shop }, orderBy: { threshold: "asc" } }),
    prisma.ledgerEntry.findMany({ where: { memberId: member.id }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.redemption.findMany({ where: { memberId: member.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.loyaltyOrder.findMany({ where: { memberId: member.id }, orderBy: { paidAt: "desc" }, take: 50 }),
    prisma.referral.findMany({ where: { referrerId: member.id }, include: { referee: true }, orderBy: { createdAt: "desc" } }),
  ]);
  const progress = nextTierProgress(tiers, member.tierSpend || 0);

  return {
    member: {
      id: member.id,
      customerId: member.customerId,
      name: [member.firstName, member.lastName].filter(Boolean).join(" ") || member.email || "Customer",
      email: member.email,
      balance: member.balance,
      pending: member.pending,
      worth: formatMoney(pointsToMoney(member.balance, settings.pointValue), settings.currencyCode),
      lifetimeEarned: member.lifetimeEarned,
      lifetimeSpent: member.lifetimeSpent,
      tierId: member.tierId,
      tierName: member.tier?.name || "—",
      tierLocked: member.tierLocked,
      nextTier: progress.next?.name || null,
      spendToNext: formatMoney(progress.pointsNeeded, settings.currencyCode),
      tierSpend: formatMoney(member.tierSpend || 0, settings.currencyCode),
      progress: progress.progress,
      excluded: member.excluded,
      referralCode: member.referralCode,
      referredBy: member.referredBy ? { id: member.referredBy.id, name: member.referredBy.firstName || member.referredBy.email } : null,
      birthday: member.birthMonth ? `${member.birthDay} ${new Date(2024, member.birthMonth - 1, 1).toLocaleString("en-IN", { month: "long" })}` : null,
      instagram: member.instagramHandle,
      signedInAt: member.signedInAt,
      createdAt: member.createdAt,
      ordersCount: member.ordersCount,
      totalSpent: formatMoney(member.totalSpent, settings.currencyCode),
    },
    tiers: tiers.map((t) => ({ id: t.id, name: t.name })),
    ledger: ledger.map((e) => ({
      id: e.id,
      type: e.type,
      label: LEDGER_LABELS[e.type],
      description: e.description,
      points: e.points,
      status: e.status,
      remaining: e.remaining,
      expiresAt: e.expiresAt,
      createdBy: e.createdBy,
      date: e.createdAt,
    })),
    redemptions: redemptions.map((r) => ({
      id: r.id,
      code: r.code,
      label: r.label,
      points: r.points,
      status: r.status,
      expiresAt: r.expiresAt,
      usedOrderId: r.usedOrderId,
      date: r.createdAt,
    })),
    orders: orders.map((o) => ({
      id: o.id,
      orderId: o.orderId,
      name: o.orderName || `#${o.orderId}`,
      points: o.points,
      reversed: o.pointsReversed,
      status: o.status,
      paidAt: o.paidAt,
      deliveredAt: o.deliveredAt,
      releaseAt: o.releaseAt,
    })),
    referrals: referrals.map((r) => ({
      id: r.id,
      name: r.referee.firstName || r.referee.email || "Friend",
      refereeId: r.refereeId,
      status: r.status,
      reason: r.rejectReason,
      date: r.createdAt,
    })),
  };
}

export async function action({ request, params }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");
  const member = await prisma.member.findFirst({ where: { id: params.id, shop } });
  if (!member) return { error: "Member not found" };
  const staff = session.email || "staff";

  try {
    switch (intent) {
      case "adjust": {
        const sign = form.get("direction") === "remove" ? -1 : 1;
        const points = Math.abs(Number.parseInt(form.get("points"), 10)) * sign;
        await adjustPoints(shop, member.id, { points, reason: form.get("reason"), staff }, admin);
        return { toast: sign > 0 ? "Coins added" : "Coins removed" };
      }
      case "exclude":
      case "include":
        if (intent === "exclude" && form.get("confirm") !== "EXCLUDE") {
          return { error: "Type EXCLUDE to confirm." };
        }
        await prisma.member.update({ where: { id: member.id }, data: { excluded: intent === "exclude" } });
        return { toast: intent === "exclude" ? "Member excluded" : "Member included again" };
      case "tier": {
        const tierId = form.get("tierId");
        const effects = [];
        await withMemberLock(member.id, async (tx, locked) => {
          if (tierId === "auto") {
            await tx.member.update({ where: { id: locked.id }, data: { tierLocked: false } });
            return;
          }
          const tier = await tx.tier.findFirst({ where: { id: String(tierId), shop } });
          if (!tier) throw new LoyaltyError("NO_TIER", "Pick a tier.");
          await setTier(tx, locked, tier, { lock: true, direction: "manual" }, effects);
        });
        await runEffects(shop, effects, admin);
        return { toast: tierId === "auto" ? "Tier follows spend again" : "Tier set" };
      }
      case "cancel-code": {
        const redemption = await prisma.redemption.findFirst({ where: { id: String(form.get("redemptionId")), memberId: member.id, status: "ISSUED" } });
        if (!redemption) return { error: "That code can't be cancelled." };
        if (redemption.discountNodeId) await deleteDiscount(admin, redemption.discountNodeId).catch(() => null);
        const effects = [];
        await withMemberLock(member.id, async (tx, locked) => {
          const debit = await tx.ledgerEntry.findUnique({ where: { shop_idempotencyKey: { shop, idempotencyKey: `redeem:${redemption.id}` } } });
          if (debit) await restoreDebit(tx, locked, debit, { key: `restore:${redemption.id}`, description: `Code ${redemption.code} cancelled by staff`, createdBy: staff }, effects);
          await tx.redemption.update({ where: { id: redemption.id }, data: { status: "CANCELLED" } });
        });
        await runEffects(shop, effects, admin);
        return { toast: "Code cancelled and coins returned" };
      }
      default:
        return { error: "Unknown action" };
    }
  } catch (err) {
    if (err instanceof LoyaltyError) return { error: err.message };
    throw err;
  }
}

const STATUS_TONE = { ISSUED: "info", USED: "success", EXPIRED: "neutral", CANCELLED: "neutral", FAILED: "critical", PENDING: "warning", CREDITED: "success", SIGNED_UP: "info", REWARDED: "success", REJECTED: "critical" };

export default function MemberDetail() {
  const { member, tiers, ledger, redemptions, orders, referrals } = useLoaderData();
  const result = useActionData();
  useActionToast(result);
  const busy = useBusy();

  return (
    <s-page heading={member.name} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/members">Members</s-link>
      <s-button slot="secondary-actions" href={`shopify://admin/customers/${member.customerId}`} target="_blank">
        View in Shopify
      </s-button>
      <s-button slot="primary-action" variant="primary" commandFor="adjust-modal" command="--show">
        Adjust coins
      </s-button>

      {member.excluded ? (
        <s-banner tone="critical" heading="Excluded from the club">
          This member can't earn or redeem coins. Their balance is kept.
        </s-banner>
      ) : null}

      <s-section>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          <Stat label="Spendable" value={formatPoints(member.balance)} help={`Worth ${member.worth}`} />
          <Stat label="Pending" value={formatPoints(member.pending)} help="Unlocks after delivery + return window" />
          <Stat label="Earned ever" value={formatPoints(member.lifetimeEarned)} help={`${formatPoints(member.lifetimeSpent)} redeemed`} />
          <Stat
            label="Tier"
            value={member.tierName}
            help={member.tierLocked ? "Set by staff" : `${member.tierSpend} spent in window${member.nextTier ? ` · ${member.spendToNext} more for ${member.nextTier}` : ""}`}
          />
        </s-grid>
      </s-section>

      <s-section heading="Coins history">
        {ledger.length === 0 ? (
          <s-paragraph>No coins activity yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Activity</s-table-header>
              <s-table-header format="numeric">Coins</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Expires</s-table-header>
              <s-table-header>By</s-table-header>
              <s-table-header>Date</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {ledger.map((e) => (
                <s-table-row key={e.id}>
                  <s-table-cell>
                    <s-stack gap="small-500">
                      <s-badge tone={ledgerTone(e.type, e.points)}>{e.label}</s-badge>
                      <s-text color="subdued">{e.description}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{e.points > 0 ? `+${formatPoints(e.points)}` : formatPoints(e.points)}</s-table-cell>
                  <s-table-cell>
                    {e.status === "PENDING" ? <s-badge tone="warning">Pending</s-badge> : e.status === "CANCELLED" ? <s-badge>Cancelled</s-badge> : "—"}
                  </s-table-cell>
                  <s-table-cell>{e.points > 0 && e.remaining > 0 && e.expiresAt ? formatDate(e.expiresAt) : "—"}</s-table-cell>
                  <s-table-cell>{e.createdBy}</s-table-cell>
                  <s-table-cell>{formatDate(e.date, true)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Reward codes">
        {redemptions.length === 0 ? (
          <s-paragraph>No rewards redeemed yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Code</s-table-header>
              <s-table-header>Reward</s-table-header>
              <s-table-header format="numeric">Coins</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Expires</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {redemptions.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>{r.code || "Store credit"}</s-table-cell>
                  <s-table-cell>{r.label}</s-table-cell>
                  <s-table-cell>{formatPoints(r.points)}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[r.status]}>{r.status.toLowerCase()}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{formatDate(r.expiresAt)}</s-table-cell>
                  <s-table-cell>
                    {r.status === "ISSUED" ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="cancel-code" />
                        <input type="hidden" name="redemptionId" value={r.id} />
                        <s-button type="submit" variant="tertiary" tone="critical">
                          Cancel &amp; refund coins
                        </s-button>
                      </Form>
                    ) : null}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Orders">
        {orders.length === 0 ? (
          <s-paragraph>No orders since joining.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header format="numeric">Coins</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Delivered</s-table-header>
              <s-table-header>Unlocks</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {orders.map((o) => (
                <s-table-row key={o.id}>
                  <s-table-cell>
                    <s-link href={`shopify://admin/orders/${o.orderId}`} target="_blank">
                      {o.name}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    {formatPoints(o.points - o.reversed)}
                    {o.reversed ? ` (${formatPoints(o.reversed)} reversed)` : ""}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[o.status]}>{o.status === "CREDITED" ? "unlocked" : o.status.toLowerCase()}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{formatDate(o.deliveredAt)}</s-table-cell>
                  <s-table-cell>{o.status === "PENDING" ? (o.releaseAt ? formatDate(o.releaseAt) : "After shipping") : "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="Profile">
        <s-stack gap="small">
          <Row label="Email" value={member.email || "—"} />
          <Row label="Orders" value={`${member.ordersCount} · ${member.totalSpent}`} />
          <Row label="Joined" value={formatDate(member.createdAt)} />
          <Row label="First sign-in" value={formatDate(member.signedInAt)} />
          <Row label="Birthday" value={member.birthday || "Not added"} />
          <Row label="Instagram" value={member.instagram ? `@${member.instagram}` : "Not verified"} />
          <Row label="Referral code" value={member.referralCode} />
          {member.referredBy ? (
            <s-stack direction="inline" justifyContent="space-between">
              <s-text color="subdued">Referred by</s-text>
              <s-link href={`/app/members/${member.referredBy.id}`}>{member.referredBy.name}</s-link>
            </s-stack>
          ) : null}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Tier">
        <Form method="post">
          <input type="hidden" name="intent" value="tier" />
          <s-stack gap="base">
            <s-select name="tierId" label="Tier" value={member.tierLocked ? member.tierId : "auto"} details="Setting a tier locks it until you switch back to automatic.">
              <s-option value="auto">Automatic (from spend)</s-option>
              {tiers.map((t) => (
                <s-option key={t.id} value={t.id}>
                  {t.name}
                </s-option>
              ))}
            </s-select>
            <s-button type="submit" loading={busy || undefined}>
              Save tier
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      {referrals.length ? (
        <s-section slot="aside" heading={`Referrals (${referrals.length})`}>
          <s-stack gap="small">
            {referrals.map((r) => (
              <s-stack key={r.id} direction="inline" justifyContent="space-between" alignItems="center">
                <s-link href={`/app/members/${r.refereeId}`}>{r.name}</s-link>
                <s-badge tone={STATUS_TONE[r.status]}>{r.status === "SIGNED_UP" ? "joined" : r.status.toLowerCase()}</s-badge>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      ) : null}

      <s-section slot="aside" heading="Membership">
        {member.excluded ? (
          <Form method="post">
            <input type="hidden" name="intent" value="include" />
            <s-button type="submit">Include in club again</s-button>
          </Form>
        ) : (
          <s-button tone="critical" commandFor="exclude-modal" command="--show">
            Exclude from club
          </s-button>
        )}
      </s-section>

      <Form method="post">
        <input type="hidden" name="intent" value="adjust" />
        <s-modal id="adjust-modal" heading="Adjust coins">
          <s-stack gap="base">
            <s-select name="direction" label="Action" value="add">
              <s-option value="add">Add coins</s-option>
              <s-option value="remove">Remove coins</s-option>
            </s-select>
            <s-number-field name="points" label="Coins" min="1" required />
            <s-text-field name="reason" label="Reason" placeholder="e.g. Goodwill for late delivery" required details="The member sees this in their history." />
          </s-stack>
          <s-button slot="primary-action" variant="primary" type="submit" commandFor="adjust-modal" command="--hide">
            Save
          </s-button>
          <s-button slot="secondary-actions" commandFor="adjust-modal" command="--hide">
            Cancel
          </s-button>
        </s-modal>
      </Form>

      <Form method="post">
        <input type="hidden" name="intent" value="exclude" />
        <s-modal id="exclude-modal" heading="Exclude this member?">
          <s-stack gap="base">
            <s-paragraph>
              They stop earning and can't redeem. Coins they already have stay on their account in case you include them again.
            </s-paragraph>
            <s-text-field name="confirm" label="Type EXCLUDE to confirm" autocomplete="off" required />
          </s-stack>
          <s-button slot="primary-action" variant="primary" tone="critical" type="submit" commandFor="exclude-modal" command="--hide">
            Exclude
          </s-button>
          <s-button slot="secondary-actions" commandFor="exclude-modal" command="--hide">
            Cancel
          </s-button>
        </s-modal>
      </Form>
    </s-page>
  );
}

function Stat({ label, value, help }) {
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        <s-text color="subdued">{help}</s-text>
      </s-stack>
    </s-box>
  );
}

function Row({ label, value }) {
  return (
    <s-stack direction="inline" justifyContent="space-between" gap="base">
      <s-text color="subdued">{label}</s-text>
      <s-text>{value}</s-text>
    </s-stack>
  );
}
