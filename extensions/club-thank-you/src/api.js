// Production app URL. For `shopify app dev`, set it to the tunnel URL the CLI prints.
export const APP_URL = "https://wearduds-loyalty-app-production-4a64.up.railway.app";

/** Calls the app with the extension's session token; throws with the server's message. */
export async function callApp(path, { method = "GET", body } = {}) {
  const token = await shopify.sessionToken.get();
  const res = await fetch(`${APP_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

export const pts = (n) => Number(n || 0).toLocaleString("en-IN");
export const money = (n) => `₹${Math.floor(Number(n || 0)).toLocaleString("en-IN")}`;
export const date = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");
