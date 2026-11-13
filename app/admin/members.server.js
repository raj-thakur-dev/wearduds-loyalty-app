/** Prisma filter for the members list and CSV export, from URL search params. */
export function memberWhere(shop, params) {
  const q = (params.get("q") || "").trim();
  const tier = params.get("tier") || "";
  const status = params.get("status") || "";
  const where = { shop };
  if (q) {
    where.OR = [
      { email: { contains: q, mode: "insensitive" } },
      { firstName: { contains: q, mode: "insensitive" } },
      { lastName: { contains: q, mode: "insensitive" } },
      { customerId: q.replace(/\D/g, "") || "__none__" },
      { referralCode: { equals: q.toUpperCase() } },
    ];
  }
  if (tier) where.tierId = tier;
  if (status === "excluded") where.excluded = true;
  if (status === "active") where.excluded = false;
  if (status === "pending") where.pending = { gt: 0 };
  if (status === "has-points") where.balance = { gt: 0 };
  if (status === "never-signed-in") where.signedInAt = null;
  return where;
}
