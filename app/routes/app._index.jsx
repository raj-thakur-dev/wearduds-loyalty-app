import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings, updateSettings } from "../loyalty/settings.server";
import { isRecent } from "../loyalty/signals.server";
import { publishConfig } from "../loyalty/config.server";
import { pointsToMoney } from "../loyalty/math";
import { Metric, formatDate, formatMoney, formatPoints, ledgerTone, useActionToast, useBusy } from "../admin/ui";
import { LEDGER_LABELS } from "../loyalty/defaults";

const DAY = 86400000;

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const settings = await getSettings(shop);
  const since = new Date(Date.now() - 30 * DAY);

  const [
    memberAgg,
    signedIn,
    issued30,
    redeemed30,
    codesIssued,
    codesUsed,
    rewardOrders,
    buyers,
    repeatBuyers,
    tiers,
    tierCounts,
    recent,
    rewardsActive,
    lastCron,
  ] = await Promise.all([
    prisma.member.aggregate({
      where: { shop, excluded: false },
      _count: true,
      _sum: { balance: true, pending: true, lifetimeEarned: true, lifetimeSpent: true },
    }),
    prisma.member.count({ where: { shop, signedInAt: { not: null } } }),
    prisma.ledgerEntry.aggregate({
      where: { shop, status: "AVAILABLE", points: { gt: 0 }, availableAt: { gte: since }, type: { not: "REDEMPTION_RESTORED" } },
      _sum: { points: true },
    }),
    prisma.ledgerEntry.aggregate({ where: { shop, type: "REDEMPTION", createdAt: { gte: since } }, _sum: { points: true } }),
    prisma.redemption.count({ where: { shop, createdAt: { gte: since }, status: { in: ["ISSUED", "USED", "EXPIRED"] } } }),
    prisma.redemption.count({ where: { shop, usedAt: { gte: since }, status: "USED" } }),
    prisma.loyaltyOrder.aggregate({
      where: { shop, paidAt: { gte: since }, NOT: { usedCodes: { isEmpty: true } } },
      _count: true,
      _sum: { eligibleAmount: true },
    }),
    prisma.member.count({ where: { shop, ordersCount: { gte: 1 } } }),
    prisma.member.count({ where: { shop, ordersCount: { gte: 2 } } }),
    prisma.tier.findMany({ where: { shop }, orderBy: { threshold: "asc" } }),
    prisma.member.groupBy({ by: ["tierId"], where: { shop, excluded: false }, _count: true }),
    prisma.ledgerEntry.findMany({
      where: { shop, NOT: { status: "CANCELLED" } },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { member: { select: { id: true, firstName: true, lastName: true, email: true } } },
    }),
    prisma.reward.count({ where: { shop, active: true } }),
    prisma.jobRun.findFirst({ where: { shop, kind: { startsWith: "birthdays:" } }, orderBy: { startedAt: "desc" } }),
  ]);

  const outstanding = memberAgg._sum.balance || 0;
  const lifetimeEarned = memberAgg._sum.lifetimeEarned || 0;
  const lifetimeSpent = memberAgg._sum.lifetimeSpent || 0;
  const storeHandle = shop.replace(".myshopify.com", "");

  return {
    shop,
    storeHandle,
    apiKey: process.env.SHOPIFY_API_KEY || "",
    live: settings.isLive,
    programName: settings.programName,
    currency: settings.currencyCode,
    stats: {
      members: memberAgg._count,
      signedIn,
      outstanding,
      liability: pointsToMoney(outstanding, settings.pointValue),
      pending: memberAgg._sum.pending || 0,
      issued30: issued30._sum.points || 0,
      redeemed30: Math.abs(redeemed30._sum.points || 0),
      redemptionRate: lifetimeEarned ? Math.round((lifetimeSpent / lifetimeEarned) * 100) : 0,
      codesIssued,
      codesUsed,
      rewardOrders: rewardOrders._count,
      rewardRevenue: rewardOrders._sum.eligibleAmount || 0,
      repeatRate: buyers ? Math.round((repeatBuyers / buyers) * 100) : 0,
    },
    tiers: tiers.map((t) => ({
      name: t.name,
      color: t.color,
      count: tierCounts.find((c) => c.tierId === t.id)?._count || 0,
    })),
    recent: recent.map((e) => ({
      id: e.id,
      memberId: e.member.id,
      name: [e.member.firstName, e.member.lastName].filter(Boolean).join(" ") || e.member.email || "Customer",
      type: e.type,
      label: LEDGER_LABELS[e.type],
      points: e.points,
      pending: e.status === "PENDING",
      date: e.createdAt,
    })),
    checklist: {
      rewardsActive,
      cronRunning: !!lastCron && Date.now() - new Date(lastCron.startedAt).getTime() < 2 * DAY,
      embed: isRecent(settings.signals?.embed, 14),
      page: isRecent(settings.signals?.page, 30),
      account: isRecent(settings.signals?.account, 60),
      integrations: isRecent(settings.signals?.judgeme, 60) || isRecent(settings.signals?.flow, 60),
    },
  };
}

export async function action({ request }) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "go-live" || intent === "pause") {
    await updateSettings(session.shop, { isLive: intent === "go-live" });
    await publishConfig(session.shop, admin).catch((err) => console.error("[club] publish failed", err.message));
    return { toast: intent === "go-live" ? "The club is live" : "The club is paused" };
  }
  if (intent === "publish") {
    await publishConfig(session.shop, admin);
    return { toast: "Storefront settings refreshed" };
  }
  return { error: "Unknown action" };
}

export default function Overview() {
  const data = useLoaderData();
  const result = useActionData();
  useActionToast(result);
  const busy = useBusy();
  const { stats } = data;
  const totalTiered = data.tiers.reduce((s, t) => s + t.count, 0) || 1;
  const editor = `https://admin.shopify.com/store/${data.storeHandle}/themes/current/editor`;

  return (
    <s-page heading={data.programName}>
      <s-button slot="secondary-actions" href="/app/members/export">Export members</s-button>

      {data.live ? (
        <s-banner tone="success" heading="The club is live">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text>Customers are earning and redeeming coins.</s-text>
            <Form method="post">
              <input type="hidden" name="intent" value="pause" />
              <s-button type="submit" variant="tertiary" tone="critical" loading={busy || undefined}>
                Pause program
              </s-button>
            </Form>
          </s-stack>
        </s-banner>
      ) : (
        <s-banner tone="warning" heading="The club isn't live yet">
          <s-stack gap="base">
            <s-paragraph>
              Only customers tagged <s-text type="strong">club-tester</s-text> earn coins and see the widget. Work
              through the checklist, then go live.
            </s-paragraph>
            <Form method="post">
              <input type="hidden" name="intent" value="go-live" />
              <s-button type="submit" variant="primary" loading={busy || undefined}>
                Go live
              </s-button>
            </Form>
          </s-stack>
        </s-banner>
      )}

      <s-section heading="Last 30 days">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
          <Metric label="Members" value={formatPoints(stats.members)} help={`${formatPoints(stats.signedIn)} signed in`} />
          <Metric
            label="Coins outstanding"
            value={formatPoints(stats.outstanding)}
            help={`${formatMoney(stats.liability, data.currency)} liability · ${formatPoints(stats.pending)} pending`}
          />
          <Metric label="Coins issued" value={formatPoints(stats.issued30)} help="Unlocked and spendable" />
          <Metric label="Coins redeemed" value={formatPoints(stats.redeemed30)} help={`${stats.redemptionRate}% of all coins earned`} />
          <Metric label="Reward codes" value={`${stats.codesUsed} / ${stats.codesIssued}`} help="Used / issued" />
          <Metric
            label="Orders using a reward"
            value={formatPoints(stats.rewardOrders)}
            help={`${formatMoney(stats.rewardRevenue, data.currency)} in sales`}
          />
          <Metric label="Repeat buyers" value={`${stats.repeatRate}%`} help="Members with 2+ orders" />
        </s-grid>
      </s-section>

      <s-section heading="Members by tier">
        <s-stack gap="base">
          {data.tiers.map((t) => {
            const pct = Math.round((t.count / totalTiered) * 100);
            return (
              <s-stack key={t.name} gap="small-200">
                <s-stack direction="inline" justifyContent="space-between">
                  <s-text type="strong">{t.name}</s-text>
                  <s-text color="subdued">
                    {formatPoints(t.count)} · {pct}%
                  </s-text>
                </s-stack>
                <div style={{ height: 8, background: "#f1f1f1", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: t.color === "#111111" ? "#303030" : t.color }} />
                </div>
              </s-stack>
            );
          })}
        </s-stack>
      </s-section>

      <s-section heading="Recent activity">
        {data.recent.length === 0 ? (
          <s-stack gap="small" alignItems="center" padding="large">
            <s-heading>No coins yet</s-heading>
            <s-paragraph>Activity shows up here once members start earning.</s-paragraph>
          </s-stack>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Member</s-table-header>
              <s-table-header>Activity</s-table-header>
              <s-table-header format="numeric">Coins</s-table-header>
              <s-table-header>Date</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.recent.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>
                    <s-link href={`/app/members/${r.memberId}`}>{r.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={r.pending ? "warning" : ledgerTone(r.type, r.points)}>
                      {r.pending ? `${r.label} (pending)` : r.label}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{r.points > 0 ? `+${formatPoints(r.points)}` : formatPoints(r.points)}</s-table-cell>
                  <s-table-cell>{formatDate(r.date, true)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="Launch checklist">
        <s-stack gap="base">
          <ChecklistItem done={data.checklist.rewardsActive > 0} title="Rewards set up" href="/app/rewards">
            {data.checklist.rewardsActive} active rewards
          </ChecklistItem>
          <ChecklistItem done={data.checklist.embed} title="Turn on the Rewards embed" href={`${editor}?context=apps`} external>
            Theme editor &gt; App embeds &gt; Wearduds Club
          </ChecklistItem>
          <ChecklistItem done={data.checklist.page} title="Add the Club page" href={`${editor}?template=page`} external>
            Create /pages/wearduds-club and add the Club page section
          </ChecklistItem>
          <ChecklistItem done={data.checklist.account} title="Add Rewards to customer accounts" href={`https://admin.shopify.com/store/${data.storeHandle}/settings/checkout`} external>
            Checkout &amp; accounts editor &gt; add the Rewards page to the menu
          </ChecklistItem>
          <ChecklistItem done={data.checklist.cronRunning} title="Scheduled jobs running" href="/app/settings">
            Unlocks coins, expiry and birthdays every hour
          </ChecklistItem>
          <ChecklistItem done={data.checklist.integrations} title="Connect Judge.me and Flow" href="/app/settings#integrations">
            Review coins and email/WhatsApp automations
          </ChecklistItem>
          <s-text color="subdued">Steps tick themselves once the store sends real traffic through them. Visit the page, then reload this screen.</s-text>
          <Form method="post">
            <input type="hidden" name="intent" value="publish" />
            <s-button type="submit" variant="tertiary" loading={busy || undefined}>
              Refresh storefront settings
            </s-button>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function ChecklistItem({ done, title, href, external, children }) {
  return (
    <s-grid gridTemplateColumns="20px 1fr" gap="small" alignItems="start">
      <s-icon type={done ? "check-circle-filled" : "circle"} tone={done ? "success" : "neutral"} />
      <s-stack gap="small-500">
        <s-link href={href} target={external ? "_blank" : undefined}>
          {title}
        </s-link>
        <s-text color="subdued">{children}</s-text>
      </s-stack>
    </s-grid>
  );
}
