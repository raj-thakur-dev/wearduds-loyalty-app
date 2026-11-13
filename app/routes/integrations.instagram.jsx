import { completeInstagramVerification } from "../loyalty/actions.server";
import {
  fetchInstagramProfile,
  sendInstagramMessage,
  verifyMetaSignature,
} from "../loyalty/integrations.server";
import { normaliseShop, safeEqual } from "../loyalty/http.server";
import { getSettings } from "../loyalty/settings.server";

// Instagram follow verification via the Meta messaging webhook.
// The member DMs their code (e.g. WD7K3PQ2) to @wearduds; Meta forwards the
// message here; we check `is_user_follow_business` and award the points.
// Env: META_APP_SECRET, META_VERIFY_TOKEN, IG_ACCESS_TOKEN, INSTAGRAM_SHOP.

export async function loader({ request }) {
  const url = new URL(request.url);
  if (
    url.searchParams.get("hub.mode") === "subscribe" &&
    safeEqual(url.searchParams.get("hub.verify_token"), process.env.META_VERIFY_TOKEN)
  ) {
    return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

const CODE = /\bWD[A-HJ-NP-Z2-9]{6}\b/;

export async function action({ request }) {
  const raw = await request.text();
  if (!verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"), process.env.META_APP_SECRET)) {
    return new Response("Bad signature", { status: 401 });
  }
  const shop = normaliseShop(process.env.INSTAGRAM_SHOP);
  if (!shop) return new Response("Not configured", { status: 200 });
  const settings = await getSettings(shop);
  const handle = settings.earnRules.instagram.handle;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("OK", { status: 200 });
  }

  for (const entry of payload.entry || []) {
    for (const event of entry.messaging || []) {
      const text = event.message?.text?.toUpperCase() || "";
      const igsid = event.sender?.id;
      const match = text.match(CODE);
      if (!igsid || !match || event.message?.is_echo) continue;
      try {
        if (!settings.earnRules.instagram.enabled) continue;
        const profile = await fetchInstagramProfile(igsid);
        if (!profile.is_user_follow_business) {
          await sendInstagramMessage(igsid, `Almost there! Follow @${handle}, then send your code ${match[0]} again.`);
          continue;
        }
        const res = await completeInstagramVerification(shop, match[0], { igsid, username: profile.username });
        const reply = {
          verified: `You're verified 🙌 ${settings.earnRules.instagram.points} points are in your ${settings.programName} account.`,
          already_verified: "This club account is already verified. Thanks for the follow!",
          account_used: "This Instagram account has already claimed the follow reward.",
          unknown_code: "We couldn't find that code. Copy it again from the Rewards page on our site.",
        }[res.status];
        if (reply) await sendInstagramMessage(igsid, reply);
      } catch (err) {
        console.error("[club] instagram verification failed:", err.message);
      }
    }
  }
  return new Response("OK", { status: 200 });
}
