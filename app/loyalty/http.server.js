import crypto from "node:crypto";
import { LoyaltyError } from "./ledger.server";

export function json(data, init = {}) {
  const status = typeof init === "number" ? init : init.status || 200;
  const headers = new Headers(typeof init === "number" ? {} : init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

/** Turns engine errors into safe JSON; unexpected errors are logged and hidden. */
export function errorResponse(err, wrap = (r) => r) {
  if (err instanceof Response) return wrap(err);
  if (err instanceof LoyaltyError) {
    return wrap(json({ error: err.message, code: err.code }, err.status));
  }
  console.error("[club] unexpected error:", err);
  return wrap(json({ error: "Something went wrong. Please try again.", code: "SERVER_ERROR" }, 500));
}

export async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const text = await request.text();
    if (text.length > 10000) throw new LoyaltyError("TOO_LARGE", "Request too large.", 413);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new LoyaltyError("BAD_JSON", "Invalid JSON.", 400);
    }
  }
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

export function normaliseShop(value) {
  const s = String(value || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
}

// Small in-memory limiter for storefront endpoints (per process). Railway runs
// one instance; behind several instances this still caps each one.
const buckets = new Map();
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.reset < now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    if (buckets.size > 50000) buckets.clear();
    return;
  }
  bucket.count++;
  if (bucket.count > limit) throw new LoyaltyError("RATE_LIMITED", "Too many requests. Slow down a little.", 429);
}
