# Wearduds Club: rebuild plan

Custom loyalty app for one merchant: Wearduds (production store + the dev store
`wearduds-loyalty-dev-cwdne41t.myshopify.com`). Scope B of proposal
RBR-WD-PH3-2026. Client brief v3 and mockups are used as reference for business
rules only; the UI is our own.

## 1. Why a rebuild, not a patch

The current code (commit `1ba3198`) has two databases that never talk
(Supabase for earning, SQLite for redeeming), trusts a customer ID sent from the
browser, issues discount codes anyone can use, lacks the scopes and webhooks it
needs, and does not build. Fixing those touches every file, so the data layer,
engine and routes are rewritten. The Shopify app scaffold, auth and deploy setup
are kept.

## 2. Architecture

| Layer | Choice | Reason |
| --- | --- | --- |
| Runtime | Shopify React Router app template (kept) | Official stack, already deployed on Railway |
| Database | PostgreSQL via Prisma (single DB) | Proposal promise; survives deploys; row locks for safe balances |
| Admin UI | Polaris web components (`<s-*>`) | Current Shopify standard; Polaris React is deprecated and was never installed |
| Storefront | Theme app extension: app embed + 4 app blocks | Works on any theme (Prestige or Horizon), merchant can place blocks |
| Customer accounts | Customer account UI extensions (full page + profile block + order block) | Brief requires new customer accounts; theme Liquid cannot render there |
| Post-purchase | Thank-you page block | Allowed on all plans |
| Automations | Shopify Flow triggers + customer metafields/tags | Merchant sends email/WhatsApp from Shopify Email, Klaviyo or a WhatsApp app without us hard-coding a provider |
| Jobs | `POST /internal/cron` protected by `CRON_SECRET`, hit hourly by Railway cron | Release pending points, expire points, birthdays, expiry warnings |

All tables carry `shop`, so the dev and production stores never mix.

## 3. Core rules engine

* **Ledger first.** Every point movement is a `LedgerEntry` with a unique
  idempotency key (`order:{id}`, `refund:{id}`, `birthday:{year}` ...). Webhook
  retries can never double-award.
* **Pending to available.** Purchase points are created as PENDING when an order
  is paid, and become AVAILABLE `holdDays` after the trigger (default: delivered
  + 7 days). Fallback release after `fulfilledAt + fallbackDays` when the courier
  never reports delivery.
* **FIFO expiry.** Each earn entry tracks `remaining`. Redemptions consume the
  oldest points first; the expiry job expires what is left after `expiryDays`.
* **Tiers on lifetime earned** (available points only, never reduced by
  redeeming). Re-evaluated after every credit. Downgrade only after
  `downgradeAfterDays` without an order.
* **Atomic redemption.** Conditional decrement inside a DB transaction, then the
  Shopify discount is created; on Shopify failure the points are restored.
* **Discount codes locked to the customer** (`context.customers`), single use,
  with an expiry date and a minimum subtotal. The minimum subtotal is
  `value / maxRedeemPercent`, so a reward can never exceed the max-% rule.
* **Refunds** reverse points in proportion to the refunded amount, per refund ID.
  Cancelled orders cancel pending points.

## 4. Feature list

### Earning (each rule toggled and valued in admin)
Purchase (per ₹, tier multiplier), signup bonus (granted on first real sign-in,
so guest-checkout customers do not get it automatically), birthday (+ one-time
bonus for adding DOB), product review and photo review (Judge.me webhook or
Shopify Flow), referral (referrer on friend's first completed order, friend on
signup), Instagram follow (honour system, one-time), newsletter opt-in
(customers/update consent), retroactive credit for existing customers (admin
job with dry run, % of lifetime spend, capped).

### Redeeming
Fixed rewards catalogue (₹ off with min order, % off, free shipping), "choose
your amount" points slider in cart, optional Shopify store credit. Codes come
back with an auto-apply link.

### Admin
Overview with liability in ₹, issued vs redeemed, redemption rate, tier mix and
setup checklist. Members table (search, filters, sort, pagination, CSV export,
bulk adjust). Member detail (ledger, codes, referrals, adjust with reason,
exclude). Earn rules, Tiers, Rewards, Referrals, Settings, Integrations,
Danger zone (retro credit with dry run and type-to-confirm). Admin block on the
Shopify customer page.

### Storefront
App embed: floating launcher + panel, referral capture, cart attribute,
`window.WeardudsClub` JS API. Blocks: Club page section, PDP "earn X points",
cart rewards (balance, slider, earn estimate), account card for themes using
classic accounts. Customer account: Rewards page, profile card, order "points
for this order". Thank-you page: points earned / create-account nudge.

### Security and compliance
App proxy signature verified and only `logged_in_customer_id` trusted; customer
account and checkout requests verified with session tokens; Judge.me/Flow
endpoints with shared secrets; rate limit on redeem; GDPR webhooks
(customers/data_request, customers/redact, shop/redact); no PII in logs.

## 5. Phases

1. Foundation: schema, migrations, config, scopes, webhooks, security fixes.
2. Engine: earn, pending/release, refunds, tiers, expiry, redemption, unit tests.
3. Earn actions and jobs: signup, DOB/birthday, referral, reviews, IG,
   newsletter, retro credit, Flow triggers, metafield sync.
4. Admin UI.
5. Storefront extensions and customer account/thank-you extensions.
6. QA: unit + route tests, build, lint, typecheck, visual checks, deploy notes.

## 6. Confirmed in client meeting (discussion points PDF)

* Earning: purchase 1 pt/₹1 (7 days after delivery), signup 100 (on verified
  sign-in), review 50 / photo review 100 (delivered product, 20+ words,
  moderated), DOB 50, birthday 200 (3 days early), referrer 300 (after friend's
  first order ships), referred friend 100 (on signup). Newsletter 25 not yet
  confirmed: shipped disabled.
* Redemption: Option A, cash value 100 pts = ₹10, max 20% of order, minimum
  order per tile, cart slider + Club page tiles.
* Tiers: Silver 0 (1x), Gold 5,000 (1.25x), Platinum 15,000 (1.5x), on lifetime
  points.
* Instagram follow must be verified: member DMs a one-time code to @wearduds;
  Meta messaging webhook + User Profile API `is_user_follow_business` confirms
  the follow. Needs a Meta app with `instagram_business_basic` +
  `instagram_business_manage_messages`, and Meta App Review for public use.

## 7. Open items for the client (defaults shipped, all editable in admin)

| Topic | Default | Note |
| --- | --- | --- |
| Earn rate / point value | 1 pt per ₹1, 100 pts = ₹10 | Equals 10% back before tier multipliers (up to 15% at top tier). Above market (Indian D2C is usually 2 to 5%). Confirm margin. |
| Points credited | 7 days after delivery | Needs courier tracking to update Shopify; fallback after 15 days from fulfilment |
| Checkout | Discount codes | If Wearduds uses GoKwik/Shopflo/Razorpay Magic, store credit will not show; codes work everywhere |
| Instagram verification | Built, off until Meta app is approved | Client must own the Meta app + business verification |
| Newsletter 25 pts | Disabled | Not confirmed in meeting |
| Email/WhatsApp | Via Shopify Flow triggers | Pick sender: Shopify Email, Klaviyo or a WhatsApp app |
