import crypto from "node:crypto";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getSettings, updateSettings, validateSettingsInput } from "../loyalty/settings.server";
import { publishConfig } from "../loyalty/config.server";
import { runRetroCredit, validateRetroInput } from "../loyalty/retro.server";
import { FieldErrors, formatDate, formatPoints, useActionToast, useBusy } from "../admin/ui";

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const s = await getSettings(shop);
  const appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  const [retroRuns, lastCron] = await Promise.all([
    prisma.jobRun.findMany({ where: { shop, kind: { in: ["retro", "retro-preview"] } }, orderBy: { startedAt: "desc" }, take: 5 }),
    prisma.jobRun.findFirst({ where: { shop, kind: { startsWith: "birthdays:" } }, orderBy: { startedAt: "desc" } }),
  ]);
  return {
    shop,
    programName: s.programName,
    widget: s.widget,
    integrations: {
      judgeme: `${appUrl}/integrations/judgeme?shop=${shop}&key=${s.integrationSecret}`,
      flowUrl: `${appUrl}/integrations/flow`,
      secret: s.integrationSecret,
      instagramWebhook: `${appUrl}/integrations/instagram`,
      instagramReady: !!(process.env.META_APP_SECRET && process.env.IG_ACCESS_TOKEN && process.env.INSTAGRAM_SHOP),
      cronUrl: `${appUrl}/internal/cron`,
      cronReady: !!process.env.CRON_SECRET,
      lastCron: lastCron?.startedAt || null,
    },
    retroRuns: retroRuns.map((r) => ({ id: r.id, kind: r.kind, status: r.status, params: r.params, result: r.result, at: r.startedAt })),
  };
}

export async function action({ request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "program") {
    const res = validateSettingsInput({ programName: form.get("programName") });
    if (res.errors) return { errors: res.errors };
    const current = await getSettings(shop);
    const widget = {
      ...current.widget,
      accent: /^#[0-9a-fA-F]{6}$/.test(form.get("accent")) ? form.get("accent") : current.widget.accent,
      launcherLabel: String(form.get("launcherLabel") || "Rewards").slice(0, 20),
      launcherPosition: form.get("launcherPosition") === "left" ? "left" : "right",
      showLauncher: form.get("showLauncher") === "on",
      guestHeadline: String(form.get("guestHeadline") || "").slice(0, 80),
      guestBody: String(form.get("guestBody") || "").slice(0, 200),
      clubPageUrl: String(form.get("clubPageUrl") || "/pages/wearduds-club").slice(0, 120),
    };
    await updateSettings(shop, { ...res.data, widget });
    await publishConfig(shop, admin).catch(() => null);
    return { toast: "Settings saved" };
  }

  if (intent === "rotate-secret") {
    if (form.get("confirm") !== "ROTATE") return { error: "Type ROTATE to confirm." };
    await updateSettings(shop, { integrationSecret: crypto.randomBytes(24).toString("hex") });
    return { toast: "New key created. Update Judge.me and Flow." };
  }

  if (intent === "retro-preview" || intent === "retro-run") {
    const res = validateRetroInput({ percent: form.get("percent"), cap: form.get("cap") });
    if (res.errors) return { errors: res.errors };
    if (intent === "retro-run" && form.get("confirm") !== "AWARD") return { error: "Type AWARD to confirm." };
    try {
      const out = await runRetroCredit(shop, admin, { ...res.data, dryRun: intent === "retro-preview" });
      return {
        toast:
          intent === "retro-preview"
            ? `Preview: ${formatPoints(out.eligible)} customers would get ${formatPoints(out.points)} coins`
            : `Awarded ${formatPoints(out.points)} coins to ${formatPoints(out.eligible)} customers`,
        retro: out,
      };
    } catch (err) {
      return { error: `Stopped: ${err.message}. It's safe to run again; nobody is paid twice.` };
    }
  }
  return { error: "Unknown action" };
}

export default function Settings() {
  const data = useLoaderData();
  const result = useActionData();
  useActionToast(result);
  const busy = useBusy();
  const w = data.widget;
  const i = data.integrations;

  return (
    <s-page heading="Settings">
      <FieldErrors errors={result?.errors} />

      <s-section heading="Program and widget">
        <Form method="post">
          <input type="hidden" name="intent" value="program" />
          <s-stack gap="base">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
              <s-text-field name="programName" label="Program name" value={data.programName} />
              <s-color-field name="accent" label="Accent colour" value={w.accent} />
              <s-text-field name="launcherLabel" label="Launcher button text" value={w.launcherLabel} />
              <s-select name="launcherPosition" label="Launcher position" value={w.launcherPosition}>
                <s-option value="right">Bottom right</s-option>
                <s-option value="left">Bottom left</s-option>
              </s-select>
              <s-text-field name="clubPageUrl" label="Club page URL" value={w.clubPageUrl} />
            </s-grid>
            <s-switch name="showLauncher" label="Show the floating Rewards button" checked={w.showLauncher || undefined} details="Turn off if the theme links to the panel from its own menu or bottom nav." />
            <s-text-field name="guestHeadline" label="Headline for visitors who aren't signed in" value={w.guestHeadline} />
            <s-text-area name="guestBody" label="Text for visitors who aren't signed in" value={w.guestBody} rows={2} />
            <s-stack direction="inline" justifyContent="end">
              <s-button type="submit" variant="primary" loading={busy || undefined}>
                Save
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Integrations" id="integrations">
        <s-stack gap="large">
          <IntegrationBlock title="Judge.me reviews" ready>
            In Judge.me go to Settings &gt; Integrations &gt; Webhooks, add this URL for <s-text type="strong">review created</s-text> and{" "}
            <s-text type="strong">review updated</s-text>:
            <CopyValue value={i.judgeme} />
          </IntegrationBlock>
          <IntegrationBlock title="Shopify Flow" ready>
            Use the four <s-text type="strong">Club</s-text> triggers (coins earned, tier changed, reward redeemed, coins expiring) to send email or
            WhatsApp. To give coins from Flow, add a <s-text type="strong">Send HTTP request</s-text> action to <CopyValue value={i.flowUrl} /> with
            header <s-text type="strong">X-Club-Key</s-text>: <CopyValue value={i.secret} />
          </IntegrationBlock>
          <IntegrationBlock title="Instagram follow check" ready={i.instagramReady}>
            Set META_APP_SECRET, META_VERIFY_TOKEN, IG_ACCESS_TOKEN and INSTAGRAM_SHOP on the server, then subscribe the Meta app's Instagram
            messages webhook to <CopyValue value={i.instagramWebhook} />
          </IntegrationBlock>
          <IntegrationBlock title="Scheduled jobs" ready={i.cronReady && !!i.lastCron}>
            Every hour, POST to <CopyValue value={i.cronUrl} /> with header <s-text type="strong">Authorization: Bearer CRON_SECRET</s-text>. Last daily
            run: {i.lastCron ? formatDate(i.lastCron, true) : "never"}.
          </IntegrationBlock>
          <Form method="post">
            <input type="hidden" name="intent" value="rotate-secret" />
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-text-field name="confirm" label="Rotate the integration key (type ROTATE)" autocomplete="off" />
              <s-button type="submit" tone="critical">
                Rotate key
              </s-button>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="Welcome-back coins for existing customers">
        <Form method="post">
          <s-stack gap="base">
            <s-paragraph>
              Give customers who shopped before launch a share of their lifetime spend as coins, with a cap. Preview first. Each customer is only
              ever paid once, so a run that stops can be restarted.
            </s-paragraph>
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
              <s-number-field name="percent" label="% of lifetime spend" value="50" min="1" max="100" suffix="%" />
              <s-number-field name="cap" label="Cap per customer (coins)" value="2500" min="1" />
              <s-select name="intent" label="Mode" value="retro-preview">
                <s-option value="retro-preview">Preview only</s-option>
                <s-option value="retro-run">Award coins for real</s-option>
              </s-select>
              <s-text-field name="confirm" label="To award, type AWARD" autocomplete="off" />
            </s-grid>
            {result?.retro ? (
              <s-banner tone="info">
                {formatPoints(result.retro.customers)} customers checked · {formatPoints(result.retro.eligible)} eligible ·{" "}
                {formatPoints(result.retro.points)} points
              </s-banner>
            ) : null}
            <s-stack direction="inline" gap="base" justifyContent="end">
              <s-button type="submit" variant="primary" loading={busy || undefined}>
                Run
              </s-button>
            </s-stack>
            {data.retroRuns.length ? (
              <s-table>
                <s-table-header-row>
                  <s-table-header>Run</s-table-header>
                  <s-table-header>Settings</s-table-header>
                  <s-table-header>Result</s-table-header>
                  <s-table-header>When</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {data.retroRuns.map((r) => (
                    <s-table-row key={r.id}>
                      <s-table-cell>
                        <s-badge tone={r.status === "DONE" ? "success" : r.status === "FAILED" ? "critical" : "info"}>
                          {r.kind === "retro" ? "Award" : "Preview"} · {r.status.toLowerCase()}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        {r.params?.percent}% · cap {formatPoints(r.params?.cap)}
                      </s-table-cell>
                      <s-table-cell>
                        {formatPoints(r.result?.eligible || 0)} customers · {formatPoints(r.result?.points || 0)} pts
                      </s-table-cell>
                      <s-table-cell>{formatDate(r.at, true)}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            ) : null}
          </s-stack>
        </Form>
      </s-section>

      <s-section slot="aside" heading="Testing before launch">
        <s-paragraph>
          While the club isn't live, only customers tagged <s-text type="strong">club-tester</s-text> earn coins and see their balance. Tag yourself
          in Shopify, place a test order, and check the Members page.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function IntegrationBlock({ title, ready, children }) {
  return (
    <s-stack gap="small">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-heading>{title}</s-heading>
        <s-badge tone={ready ? "success" : "warning"}>{ready ? "Ready" : "Needs setup"}</s-badge>
      </s-stack>
      <s-paragraph>{children}</s-paragraph>
    </s-stack>
  );
}

function CopyValue({ value }) {
  return (
    <code
      style={{ display: "block", wordBreak: "break-all", background: "#f6f6f7", padding: "6px 8px", borderRadius: 6, margin: "4px 0", fontSize: 12 }}
    >
      {value}
    </code>
  );
}
