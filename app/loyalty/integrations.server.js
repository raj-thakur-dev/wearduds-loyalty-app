import crypto from "node:crypto";
import prisma from "../db.server";
import { normaliseShop, safeEqual } from "./http.server";
import { LoyaltyError } from "./ledger.server";
import { customerIdFromGid } from "./members.server";

/** Resolves the shop for an inbound integration call and checks its shared secret. */
export async function verifyIntegration(shopParam, secret) {
  const shop = normaliseShop(shopParam);
  if (!shop) throw new LoyaltyError("BAD_SHOP", "Unknown shop.", 401);
  const settings = await prisma.programSettings.findUnique({ where: { shop } });
  if (!settings || !safeEqual(secret, settings.integrationSecret)) {
    throw new LoyaltyError("BAD_SECRET", "Unauthorised.", 401);
  }
  return shop;
}

/** Maps a Judge.me review webhook body onto our review award input. */
export function parseJudgeMeReview(body) {
  const review = body?.review || body || {};
  const reviewer = review.reviewer || {};
  const pictures = review.pictures || review.pictures_urls || review.media || [];
  const verified = String(review.verified || reviewer.verified || "").toLowerCase();
  const curated = String(review.curated || "").toLowerCase();
  return {
    reviewId: review.id ? `judgeme:${review.id}` : null,
    email: reviewer.email || review.email || null,
    customerId: customerIdFromGid(reviewer.external_id || reviewer.shopify_customer_id || null),
    body: review.body || "",
    hasPhoto: Array.isArray(pictures) ? pictures.length > 0 : false,
    verifiedBuyer: verified ? ["buyer", "verified-buyer", "verified_buyer", "true"].includes(verified) : undefined,
    // A review counts once it is published and not hidden or flagged as spam.
    published: review.published !== false && review.hidden !== true && !["spam", "not-yet"].includes(curated),
  };
}

export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!appSecret || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return safeEqual(header.slice(7), expected);
}

const GRAPH = () => `https://graph.instagram.com/${process.env.IG_GRAPH_VERSION || "v24.0"}`;

export async function fetchInstagramProfile(igsid) {
  const url = `${GRAPH()}/${encodeURIComponent(igsid)}?fields=username,is_user_follow_business&access_token=${encodeURIComponent(process.env.IG_ACCESS_TOKEN || "")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Instagram profile lookup failed: ${res.status}`);
  return res.json();
}

export async function sendInstagramMessage(igsid, text) {
  const res = await fetch(`${GRAPH()}/me/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.IG_ACCESS_TOKEN || ""}` },
    body: JSON.stringify({ recipient: { id: igsid }, message: { text } }),
  });
  if (!res.ok) console.error(`[club] Instagram reply failed: ${res.status}`);
}
