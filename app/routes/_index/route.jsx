import { redirect } from "react-router";

// Shopify opens the app at "/?shop=...": send it into the embedded admin.
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  throw redirect("/auth/login");
};
