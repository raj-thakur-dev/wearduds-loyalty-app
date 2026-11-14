import { runAllShops } from "../loyalty/jobs.server";
import { json, safeEqual } from "../loyalty/http.server";

// Hourly: cron-job.org (or any scheduler) calls
//   POST https://<app>/internal/cron   Authorization: Bearer <CRON_SECRET>
export async function action({ request }) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || !safeEqual(token, process.env.CRON_SECRET)) {
    return json({ error: "Unauthorised" }, 401);
  }
  const started = Date.now();
  const results = await runAllShops();
  // Full results go to the server log; the caller gets a short summary, because
  // cron-job.org fails a run whose response body is too large.
  console.log(`[club] cron results ${JSON.stringify(results).slice(0, 4000)}`);
  const errors = [];
  for (const [shop, steps] of Object.entries(results)) {
    for (const [step, r] of Object.entries(steps || {})) {
      if (r && r.error) errors.push(`${shop} ${step}: ${String(r.error).slice(0, 120)}`);
    }
  }
  return json({ ok: errors.length === 0, ms: Date.now() - started, shops: Object.keys(results).length, errors: errors.slice(0, 10) });
}

export function loader() {
  return json({ error: "Use POST." }, 405);
}
