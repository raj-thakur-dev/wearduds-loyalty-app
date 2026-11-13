import { Form, useActionData, useLoaderData, useSearchParams, useSubmit } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { adjustPoints } from "../loyalty/actions.server";
import { LoyaltyError } from "../loyalty/ledger.server";
import { formatDate, formatPoints, useActionToast, useBusy } from "../admin/ui";
import { memberWhere } from "../admin/members.server";

const PAGE_SIZE = 25;
const SORTS = {
  balance: { balance: "desc" },
  lifetime: { lifetimeEarned: "desc" },
  recent: { createdAt: "desc" },
  lastOrder: { lastOrderAt: { sort: "desc", nulls: "last" } },
};

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10));
  const sort = SORTS[url.searchParams.get("sort")] ? url.searchParams.get("sort") : "balance";
  const where = memberWhere(session.shop, url.searchParams);

  const [members, total, tiers] = await Promise.all([
    prisma.member.findMany({
      where,
      orderBy: [SORTS[sort], { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { tier: { select: { name: true } } },
    }),
    prisma.member.count({ where }),
    prisma.tier.findMany({ where: { shop: session.shop }, orderBy: { threshold: "asc" }, select: { id: true, name: true } }),
  ]);

  return {
    members: members.map((m) => ({
      id: m.id,
      name: [m.firstName, m.lastName].filter(Boolean).join(" ") || "—",
      email: m.email || "—",
      tier: m.tier?.name || "—",
      balance: m.balance,
      pending: m.pending,
      lifetime: m.lifetimeEarned,
      orders: m.ordersCount,
      excluded: m.excluded,
      joined: m.createdAt,
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    tiers,
    sort,
  };
}

export async function action({ request }) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const ids = form.getAll("ids").map(String).slice(0, 500);
  const points = form.get("points");
  const reason = form.get("reason");
  if (!ids.length) return { error: "Select at least one member." };
  try {
    let done = 0;
    for (const id of ids) {
      await adjustPoints(session.shop, id, { points, reason, staff: session.email || "staff" }, admin);
      done++;
    }
    return { toast: `Updated ${done} member${done === 1 ? "" : "s"}` };
  } catch (err) {
    if (err instanceof LoyaltyError) return { error: err.message };
    throw err;
  }
}

export default function Members() {
  const data = useLoaderData();
  const result = useActionData();
  useActionToast(result);
  const busy = useBusy();
  const [params] = useSearchParams();
  const submit = useSubmit();

  const pageLink = (p) => {
    const next = new URLSearchParams(params);
    next.set("page", String(p));
    return `?${next.toString()}`;
  };
  const exportLink = `/app/members/export?${new URLSearchParams([...params].filter(([k]) => k !== "page")).toString()}`;
  const filtered = params.get("q") || params.get("tier") || params.get("status");

  return (
    <s-page heading="Members">
      <s-button slot="secondary-actions" href={exportLink} target="_blank">
        Export CSV
      </s-button>

      <s-section padding="none">
        <Form method="get" onChange={(e) => submit(e.currentTarget, { replace: true })}>
          <s-box padding="base">
            <s-grid gridTemplateColumns="2fr 1fr 1fr 1fr" gap="base">
              <s-search-field name="q" label="Search" labelAccessibilityVisibility="exclusive" placeholder="Name, email, customer ID or referral code" value={params.get("q") || ""} />
              <s-select name="tier" label="Tier" labelAccessibilityVisibility="exclusive" value={params.get("tier") || ""}>
                <s-option value="">All tiers</s-option>
                {data.tiers.map((t) => (
                  <s-option key={t.id} value={t.id}>
                    {t.name}
                  </s-option>
                ))}
              </s-select>
              <s-select name="status" label="Status" labelAccessibilityVisibility="exclusive" value={params.get("status") || ""}>
                <s-option value="">Everyone</s-option>
                <s-option value="has-points">Has points</s-option>
                <s-option value="pending">Has pending points</s-option>
                <s-option value="never-signed-in">Never signed in</s-option>
                <s-option value="excluded">Excluded</s-option>
              </s-select>
              <s-select name="sort" label="Sort" labelAccessibilityVisibility="exclusive" value={data.sort}>
                <s-option value="balance">Most points</s-option>
                <s-option value="lifetime">Most earned ever</s-option>
                <s-option value="lastOrder">Last order</s-option>
                <s-option value="recent">Newest</s-option>
              </s-select>
            </s-grid>
          </s-box>
        </Form>

        <Form method="post" id="bulk">
          {data.members.length === 0 ? (
            <s-box padding="large">
              <s-stack alignItems="center" gap="small">
                <s-heading>{filtered ? "No members match" : "No members yet"}</s-heading>
                <s-paragraph>
                  {filtered
                    ? "Try a different search or clear the filters."
                    : "Customers become members when they sign in or place an order after the club goes live."}
                </s-paragraph>
                {filtered ? <s-button href="/app/members">Clear filters</s-button> : null}
              </s-stack>
            </s-box>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>
                  <span className="visually-hidden">Select</span>
                </s-table-header>
                <s-table-header listSlot="primary">Member</s-table-header>
                <s-table-header>Tier</s-table-header>
                <s-table-header format="numeric">Points</s-table-header>
                <s-table-header format="numeric">Pending</s-table-header>
                <s-table-header format="numeric">Earned ever</s-table-header>
                <s-table-header format="numeric">Orders</s-table-header>
                <s-table-header>Joined</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.members.map((m) => (
                  <s-table-row key={m.id}>
                    <s-table-cell>
                      <s-checkbox name="ids" value={m.id} accessibilityLabel={`Select ${m.name}`} />
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack gap="small-500">
                        <s-link href={`/app/members/${m.id}`}>{m.name}</s-link>
                        <s-text color="subdued">{m.email}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      {m.excluded ? <s-badge tone="critical">Excluded</s-badge> : <s-badge>{m.tier}</s-badge>}
                    </s-table-cell>
                    <s-table-cell>{formatPoints(m.balance)}</s-table-cell>
                    <s-table-cell>{m.pending ? formatPoints(m.pending) : "—"}</s-table-cell>
                    <s-table-cell>{formatPoints(m.lifetime)}</s-table-cell>
                    <s-table-cell>{m.orders}</s-table-cell>
                    <s-table-cell>{formatDate(m.joined)}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          <s-box padding="base">
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-button commandFor="bulk-modal" command="--show" disabled={data.members.length === 0 || undefined}>
                  Adjust selected
                </s-button>
                <s-text color="subdued">
                  {formatPoints(data.total)} member{data.total === 1 ? "" : "s"}
                </s-text>
              </s-stack>
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-button href={pageLink(data.page - 1)} disabled={data.page <= 1 || undefined} icon="chevron-left" accessibilityLabel="Previous page" />
                <s-text>
                  Page {data.page} of {data.pages}
                </s-text>
                <s-button href={pageLink(data.page + 1)} disabled={data.page >= data.pages || undefined} icon="chevron-right" accessibilityLabel="Next page" />
              </s-stack>
            </s-stack>
          </s-box>

          <s-modal id="bulk-modal" heading="Adjust points for selected members">
            <s-stack gap="base">
              <s-number-field name="points" label="Points" details="Use a minus sign to take points away, e.g. -200" required />
              <s-text-field name="reason" label="Reason" details="Shown in each member's history" required />
            </s-stack>
            <s-button slot="primary-action" type="submit" variant="primary" loading={busy || undefined} commandFor="bulk-modal" command="--hide">
              Apply
            </s-button>
            <s-button slot="secondary-actions" commandFor="bulk-modal" command="--hide">
              Cancel
            </s-button>
          </s-modal>
        </Form>
      </s-section>
    </s-page>
  );
}
