import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "./helpers";
import prisma from "../app/db.server";
import { getSettings } from "../app/loyalty/settings.server";
import { isRecent, recordSignals, storefrontSignals } from "../app/loyalty/signals.server";

const SHOP = "signals-test.myshopify.com";

describe("setup signals", () => {
  beforeEach(async () => {
    await resetDb(prisma);
    await getSettings(SHOP);
  });
  afterAll(() => prisma.$disconnect());

  it("parses storefront surface flags", () => {
    expect(storefrontSignals("e,p")).toEqual(["embed", "page"]);
    expect(storefrontSignals("x, e")).toEqual(["embed"]);
    expect(storefrontSignals(null)).toEqual([]);
  });

  it("records known surfaces, ignores unknown ones and merges with earlier signals", async () => {
    await recordSignals(SHOP, ["embed", "bogus"]);
    await recordSignals(SHOP, ["account"]);
    const { signals } = await prisma.programSettings.findUnique({ where: { shop: SHOP } });
    expect(Object.keys(signals).sort()).toEqual(["account", "embed"]);
    expect(isRecent(signals.embed, 1)).toBe(true);
  });

  it("treats missing or old timestamps as not done", () => {
    expect(isRecent(undefined)).toBe(false);
    expect(isRecent(new Date(Date.now() - 40 * 86400000).toISOString(), 30)).toBe(false);
  });
});
