import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings } from "../loyalty/settings.server";
import { Metric, formatDate, formatPoints } from "../admin/ui";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [settings, byStatus, points, top, recent] = await Promise.all([
    getSettings(shop),
    prisma.referral.groupBy({ by: ["status"], where: { shop }, _count: true }),
    prisma.ledgerEntry.aggregate({ where: { shop, type: { in: ["REFERRAL_REFERRER", "REFERRAL_FRIEND"] } }, _sum: { points: true } }),
    prisma.referral.groupBy({
      by: ["referrerId"],
      where: { shop, status: "REWARDED" },
      _count: true,
      orderBy: { _count: { referrerId: "desc" } },
      take: 10,
    }),
    prisma.referral.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { referrer: true, referee: true },
    }),
  ]);
  const topMembers = await prisma.member.findMany({ where: { id: { in: top.map((t) => t.referrerId) } } });
  const count = (s) => byStatus.find((b) => b.status === s)?._count || 0;
  const total = byStatus.reduce((s, b) => s + b._count, 0);
  const name = (m) => [m.firstName, m.lastName].filter(Boolean).join(" ") || m.email || "Member";
  return {
    enabled: settings.earnRules.referral.enabled,
    rule: settings.earnRules.referral,
    stats: {
      total,
      rewarded: count("REWARDED"),
      waiting: count("SIGNED_UP"),
      rejected: count("REJECTED"),
      conversion: total ? Math.round((count("REWARDED") / total) * 100) : 0,
      points: points._sum.points || 0,
    },
    top: top.map((t) => {
      const m = topMembers.find((x) => x.id === t.referrerId);
      return { id: t.referrerId, name: m ? name(m) : "Member", count: t._count };
    }),
    recent: recent.map((r) => ({
      id: r.id,
      referrer: { id: r.referrer.id, name: name(r.referrer) },
      referee: { id: r.referee.id, name: name(r.referee) },
      status: r.status,
      reason: r.rejectReason,
      date: r.createdAt,
    })),
  };
}

const TONE = { SIGNED_UP: "info", REWARDED: "success", REJECTED: "critical" };
const LABEL = { SIGNED_UP: "Waiting for first order", REWARDED: "Rewarded", REJECTED: "Not rewarded" };

export default function Referrals() {
  const { enabled, rule, stats, top, recent } = useLoaderData();
  return (
    <s-page heading="Referrals">
      {!enabled ? (
        <s-banner tone="warning" heading="Referrals are off">
          Turn them on in <s-link href="/app/earn">Ways to earn</s-link>.
        </s-banner>
      ) : null}
      <s-section>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
          <Metric label="Friends joined" value={formatPoints(stats.total)} />
          <Metric label="First orders shipped" value={formatPoints(stats.rewarded)} help={`${stats.conversion}% conversion`} />
          <Metric label="Waiting" value={formatPoints(stats.waiting)} help="Joined, no shipped order yet" />
          <Metric label="Points given" value={formatPoints(stats.points)} help={`${rule.referrerPoints} per referrer · ${rule.friendPoints} per friend`} />
        </s-grid>
      </s-section>

      <s-section heading="Recent referrals">
        {recent.length === 0 ? (
          <s-stack alignItems="center" gap="small" padding="large">
            <s-heading>No referrals yet</s-heading>
            <s-paragraph>Every member gets a share link on the Club page and in their account.</s-paragraph>
          </s-stack>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Friend</s-table-header>
              <s-table-header>Referred by</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Joined</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recent.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>
                    <s-link href={`/app/members/${r.referee.id}`}>{r.referee.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/members/${r.referrer.id}`}>{r.referrer.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack gap="small-500">
                      <s-badge tone={TONE[r.status]}>{LABEL[r.status]}</s-badge>
                      {r.reason ? <s-text color="subdued">{r.reason}</s-text> : null}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{formatDate(r.date)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="Top referrers">
        {top.length === 0 ? (
          <s-paragraph color="subdued">Nobody yet.</s-paragraph>
        ) : (
          <s-ordered-list>
            {top.map((t) => (
              <s-list-item key={t.id}>
                <s-link href={`/app/members/${t.id}`}>{t.name}</s-link> · {t.count}
              </s-list-item>
            ))}
          </s-ordered-list>
        )}
      </s-section>
      <s-section slot="aside" heading="Fraud protection">
        <s-unordered-list>
          <s-list-item>No self-referrals (same account or email)</s-list-item>
          <s-list-item>Friend must be new, with no previous orders</s-list-item>
          <s-list-item>Referrer is paid only when the first order ships, and cancelled orders don't count</s-list-item>
          <s-list-item>Monthly cap of {rule.monthlyCap || "unlimited"} rewarded referrals per member</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}
