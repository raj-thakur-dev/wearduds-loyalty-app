import { runAllShops } from "../loyalty/jobs.server";
import { json, safeEqual } from "../loyalty/http.server";

// Hourly: Railway cron (or any scheduler) calls
//   POST https://<app>/internal/cron   Authorization: Bearer <CRON_SECRET>
export async function action({ request }) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!process.env.CRON_SECRET || !safeEqual(token, process.env.CRON_SECRET)) {
    return json({ error: "Unauthorised" }, 401);
  }
  const started = Date.now();
  const results = await runAllShops();
  return json({ ok: true, ms: Date.now() - started, results });
}

export function loader() {
  return json({ error: "Use POST." }, 405);
}
