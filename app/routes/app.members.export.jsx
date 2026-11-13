import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { memberWhere } from "../admin/members.server";

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /app/members/export?q=&tier=&status=  → CSV of the filtered members.
export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const where = memberWhere(session.shop, new URL(request.url).searchParams);
  const header = [
    "Customer ID",
    "Email",
    "First name",
    "Last name",
    "Tier",
    "Points balance",
    "Pending points",
    "Lifetime points",
    "Points redeemed",
    "Orders",
    "Total spent",
    "Referral code",
    "Birthday",
    "Excluded",
    "Joined",
    "Last order",
  ];
  const rows = [header.join(",")];
  let cursor = null;
  for (;;) {
    const batch = await prisma.member.findMany({
      where,
      orderBy: { id: "asc" },
      take: 1000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: { tier: { select: { name: true } } },
    });
    for (const m of batch) {
      rows.push(
        [
          m.customerId,
          m.email,
          m.firstName,
          m.lastName,
          m.tier?.name,
          m.balance,
          m.pending,
          m.lifetimeEarned,
          m.lifetimeSpent,
          m.ordersCount,
          m.totalSpent,
          m.referralCode,
          m.birthMonth ? `${String(m.birthDay).padStart(2, "0")}/${String(m.birthMonth).padStart(2, "0")}` : "",
          m.excluded ? "yes" : "no",
          m.createdAt.toISOString().slice(0, 10),
          m.lastOrderAt ? m.lastOrderAt.toISOString().slice(0, 10) : "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    if (batch.length < 1000) break;
    cursor = batch[batch.length - 1].id;
  }
  const date = new Date().toISOString().slice(0, 10);
  return new Response(rows.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="wearduds-club-members-${date}.csv"`,
    },
  });
}
