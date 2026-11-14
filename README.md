# Wearduds Club

Custom Shopify loyalty app built for Wearduds (Scope B, proposal RBR-WD-PH3-2026).
Points, tiers, rewards, referrals, reviews, birthdays and Instagram follows, with
an embedded admin, a theme extension, customer account pages and a thank-you block.

Plan and client decisions: [`docs/PLAN.md`](docs/PLAN.md).

## How it works

| Piece | Where |
| --- | --- |
| Points engine (ledger, tiers, expiry, refunds) | `app/loyalty/*.server.js` |
| Admin (Overview, Members, Ways to earn, Rewards & tiers, Referrals, Settings) | `app/routes/app.*.jsx` |
| Storefront API (via app proxy `/apps/club/*`) | `app/routes/proxy.*.jsx` |
| Customer account + thank-you API (session tokens) | `app/routes/api.*.jsx` |
| Webhooks | `app/routes/webhooks.*.jsx` |
| Judge.me, Flow, Instagram, cron | `app/routes/integrations.*.jsx`, `internal.cron.jsx` |
| Theme blocks (embed, Club page, cart, product, account card) | `extensions/club-theme` |
| Customer account Rewards page, profile card, order points | `extensions/club-account-*` |
| Thank-you page block | `extensions/club-thank-you` |
| Flow triggers (points earned, tier changed, reward redeemed, points expiring) | `extensions/club-flow-*` |

Rules that matter:

* Purchase points are **pending** until the order is delivered + 7 days (configurable), then unlock.
* Every point movement is a ledger row with a unique key, so webhook retries never double-award.
* Redemptions take points first (row-locked), then create a **single-use code locked to that customer**
  with a minimum order that keeps the reward within the max % rule. If Shopify refuses, the points go back.
* Tiers use lifetime points; spending never drops a tier. A year without orders drops one.
* Storefront calls only trust Shopify's signed `logged_in_customer_id`.

## Local development

Requirements: Node 20.19+ or 22.12+, pnpm 9, PostgreSQL 14+, Shopify CLI.

```bash
pnpm install
cp .env.example .env            # set DATABASE_URL
pnpm prisma migrate deploy
pnpm dev                        # shopify app dev, picks the dev store
```

Use the dev store `wearduds-loyalty-dev-cwdne41t.myshopify.com`. While the club is not live, only
customers tagged `club-tester` earn points and see the widget.

For the customer account and thank-you extensions, set `APP_URL` in each `extensions/*/src/api.js`
to the tunnel URL that `shopify app dev` prints (production URL is already there).

### Tests

```bash
TEST_DATABASE_URL=postgresql://... pnpm vitest run
```

34 tests cover the maths and the full engine against a real Postgres: pending → unlock timing,
duplicate webhooks, refunds, cancellations, customer-locked codes, concurrent redemptions,
Shopify failures, expiry, birthdays, reviews, referrals and tier downgrades.

## Deploy (Render)

Dev setup: Render free web service `wearduds-club` (Docker, Singapore) at
`https://wearduds-club.onrender.com`, with Postgres on Supabase (session pooler).

1. Set `DATABASE_URL` to the Postgres connection string. SQLite is gone: it was wiped on every deploy.
   Add `?schema=wearduds` to keep the app in its own schema when the database holds other tables
   (the dev Supabase project does). Both the migration and the app read that parameter.
2. Set env vars from `.env.example` (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `CRON_SECRET`).
3. Deploy. The Docker start command runs `prisma migrate deploy` before starting.
4. Hourly cron: an external pinger (cron-job.org) sends `POST /internal/cron` with header
   `Authorization: Bearer <CRON_SECRET>` at minute 5. On a paid host, `node scripts/cron.mjs` works too.
5. `pnpm shopify app deploy` to push scopes, webhooks, metafield definitions and extensions.

Free-tier limits: the service sleeps after 15 minutes idle (first request takes about a minute, and
Shopify may retry webhooks), and free Postgres expires after 30 days. Move the DB to Neon or a paid
plan before then, and use an always-on plan for the live store.
6. In the Partner Dashboard > API access, request **protected customer data** access
   (name, email) because the app reads orders and customers.

## Store setup (after install)

1. **Theme editor > App embeds**: turn on *Wearduds Club*. Set *Lift above mobile bottom nav* to the
   bottom-nav height. Any link to `#club` (or `data-wdc-open`) opens the panel.
2. Create a page `/pages/wearduds-club` and add the **Club page** block.
3. Add **Pay with points** to the cart, **Points for this product** to the product page.
4. **Settings > Checkout > Customize** (customer accounts): add the **Rewards** page to the menu,
   the **Club card** to Profile and **Club points** to order status. Add the thank-you block.
5. Judge.me: Settings > Integrations > Webhooks, paste the URL from the app's Settings page.
6. Flow: build automations on the four Club triggers (welcome, tier-up, expiring points).
7. Test with a `club-tester` customer, then press **Go live** on the Overview.
8. Optional: Settings > *Welcome-back points* to credit existing customers (preview first).

## Instagram follow verification

Members tap *Verify follow*, get a code, and DM it to @wearduds. Meta forwards the DM to
`/integrations/instagram`; the app checks `is_user_follow_business` and awards points once per
Instagram account. Needs a Meta app with Instagram Login (`instagram_business_basic`,
`instagram_business_manage_messages`), the `messages` webhook subscribed to that URL, and Meta
App Review before it works for the public. Env: `META_APP_SECRET`, `META_VERIFY_TOKEN`,
`IG_ACCESS_TOKEN`, `INSTAGRAM_SHOP`.
