// Railway cron service entry: `node scripts/cron.mjs`, schedule "5 * * * *".
// Calls the app's job endpoint (release points, expiry, birthdays, delivery polling).
const url = `${(process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "")}/internal/cron`;
const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
const body = await res.text();
console.log(res.status, body.slice(0, 2000));
process.exit(res.ok ? 0 : 1);
