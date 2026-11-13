import prisma from "../db.server";
import { getSettings } from "./settings.server";
import { ensureMember, isExcludedByTags, customerIdFromGid } from "./members.server";
import { creditPoints, withMemberLock } from "./ledger.server";
import { fetchCustomersPage } from "./shopify-api.server";
import { runEffects } from "./effects.server";

export function retroPointsFor(amountSpent, { percent, cap, pointsPerCurrency }) {
  const raw = Math.floor(Number(amountSpent || 0) * (Number(percent) / 100) * Number(pointsPerCurrency));
  return Math.max(0, Math.min(Number(cap), raw));
}

export function validateRetroInput(input) {
  const percent = Number.parseFloat(input.percent);
  const cap = Number.parseInt(input.cap, 10);
  const errors = {};
  if (!(percent > 0 && percent <= 100)) errors.percent = "Enter 1 to 100.";
  if (!(cap > 0 && cap <= 1000000)) errors.cap = "Enter a cap above 0.";
  return Object.keys(errors).length ? { errors } : { data: { percent, cap } };
}

/**
 * Welcome-back points for customers who bought before launch.
 * `dryRun` only counts. A real run is idempotent per customer (`retro:<id>`),
 * so it is safe to re-run after a failure.
 */
export async function runRetroCredit(shop, admin, { percent, cap, dryRun }) {
  const settings = await getSettings(shop);
  const run = await prisma.jobRun.create({
    data: { shop, kind: dryRun ? "retro-preview" : "retro", params: { percent, cap } },
  });
  const totals = { customers: 0, eligible: 0, points: 0, skippedExcluded: 0 };
  try {
    let after = null;
    do {
      const page = await fetchCustomersPage(admin, after);
      for (const c of page.nodes) {
        totals.customers++;
        if (isExcludedByTags(settings, c.tags)) {
          totals.skippedExcluded++;
          continue;
        }
        const points = retroPointsFor(c.amountSpent?.amount, { percent, cap, pointsPerCurrency: settings.pointsPerCurrency });
        if (points <= 0) continue;
        totals.eligible++;
        totals.points += points;
        if (dryRun) continue;
        const member = await ensureMember(shop, customerIdFromGid(c.id), {
          email: c.defaultEmailAddress?.emailAddress,
          firstName: c.firstName,
          lastName: c.lastName,
        });
        const effects = [];
        await withMemberLock(member.id, (tx, locked) =>
          creditPoints(
            tx,
            locked,
            settings,
            { points, type: "RETRO", key: `retro:${locked.customerId}`, description: "Thanks for shopping with us before the club launched" },
            effects,
          ),
        );
        await runEffects(shop, effects, admin);
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      await prisma.jobRun.update({ where: { id: run.id }, data: { result: totals } });
    } while (after);
    await prisma.jobRun.update({ where: { id: run.id }, data: { status: "DONE", result: totals, finishedAt: new Date() } });
    return { runId: run.id, ...totals };
  } catch (err) {
    await prisma.jobRun.update({
      where: { id: run.id },
      data: { status: "FAILED", result: totals, error: String(err.message).slice(0, 500), finishedAt: new Date() },
    });
    throw err;
  }
}
