import prisma from "../db.server";
import { getSettings } from "./settings.server";
import { ensureMember, findMember, isExcludedByTags } from "./members.server";
import { creditPoints, debitPoints, withMemberLock, LoyaltyError } from "./ledger.server";
import { birthdayYearDue, randomCode, wordCount } from "./math";
import { runEffects } from "./effects.server";

/**
 * First time a customer is seen signed in (storefront or customer account).
 * Guest-checkout customers exist in Shopify without ever signing in, so the
 * welcome bonus waits for a real sign-in.
 */
export async function recordSignIn(shop, member, settings, admin) {
  if (member.signedInAt) return member;
  const effects = [];
  const updated = await withMemberLock(member.id, async (tx, locked) => {
    if (locked.signedInAt) return locked;
    await tx.member.update({ where: { id: locked.id }, data: { signedInAt: new Date() } });
    locked.signedInAt = new Date();
    const rule = settings.earnRules.signup;
    if (rule.enabled) {
      await creditPoints(
        tx,
        locked,
        settings,
        { points: rule.points, type: "SIGNUP", key: `signup:${locked.id}`, description: "Welcome to the club" },
        effects,
      );
    }
    return locked;
  });
  await runEffects(shop, effects, admin);
  return updated;
}

export function validateBirthday({ month, day, year }) {
  const m = Number.parseInt(month, 10);
  const d = Number.parseInt(day, 10);
  const y = year ? Number.parseInt(year, 10) : null;
  if (!(m >= 1 && m <= 12)) return { error: "Pick a month." };
  const maxDay = new Date(Date.UTC(2024, m, 0)).getUTCDate(); // leap year allows Feb 29
  if (!(d >= 1 && d <= maxDay)) return { error: "Pick a valid day." };
  const thisYear = new Date().getUTCFullYear();
  if (y !== null && !(y >= thisYear - 100 && y <= thisYear - 13)) return { error: "Check the year." };
  return { month: m, day: d, year: y };
}

/** Saves a birthday once. Changing it later needs staff, so the bonus can't be farmed. */
export async function setBirthday(shop, member, input, admin) {
  const settings = await getSettings(shop);
  const parsed = validateBirthday(input);
  if (parsed.error) throw new LoyaltyError("BAD_BIRTHDAY", parsed.error);
  if (member.birthMonth) throw new LoyaltyError("BIRTHDAY_SET", "Your birthday is already saved. Contact us to change it.");

  const effects = [];
  await withMemberLock(member.id, async (tx, locked) => {
    if (locked.birthMonth) return;
    await tx.member.update({
      where: { id: locked.id },
      data: { birthMonth: parsed.month, birthDay: parsed.day, birthYear: parsed.year },
    });
    Object.assign(locked, { birthMonth: parsed.month, birthDay: parsed.day });
    const rule = settings.earnRules.birthdaySetup;
    if (rule.enabled) {
      await creditPoints(
        tx,
        locked,
        settings,
        { points: rule.points, type: "BIRTHDAY_SETUP", key: `birthday-setup:${locked.id}`, description: "Added your birthday" },
        effects,
      );
    }
  });
  await runEffects(shop, effects, admin);
}

/** Cron: birthday gifts `daysBefore` days early, once per member per year. */
export async function awardBirthdays(shop, now = new Date()) {
  const settings = await getSettings(shop);
  const rule = settings.earnRules.birthday;
  if (!rule.enabled || !settings.isLive) return { awarded: 0 };

  // Candidate months: this month and next (covers the look-ahead window).
  const months = [now.getUTCMonth() + 1, ((now.getUTCMonth() + 1) % 12) + 1];
  const candidates = await prisma.member.findMany({
    where: { shop, excluded: false, birthMonth: { in: months } },
    select: { id: true, birthMonth: true, birthDay: true },
  });
  const effects = [];
  let awarded = 0;
  for (const c of candidates) {
    const year = birthdayYearDue(c, rule.daysBefore, now);
    if (!year) continue;
    const res = await withMemberLock(c.id, (tx, member) =>
      creditPoints(
        tx,
        member,
        settings,
        { points: rule.points, type: "BIRTHDAY", key: `birthday:${member.id}:${year}`, description: "Happy birthday!" },
        effects,
      ),
    );
    if (res.entry && !res.duplicate) awarded++;
  }
  await runEffects(shop, effects);
  return { awarded };
}

/** customers/update: reward an opt-in to email marketing, once. */
export async function handleCustomerUpdate(shop, customer, admin) {
  const settings = await getSettings(shop);
  const rule = settings.earnRules.newsletter;
  const member = await findMember(shop, customer.id);
  if (!member) return { skipped: "not_member" };
  const profile = {
    email: customer.email,
    firstName: customer.first_name,
    lastName: customer.last_name,
  };
  await ensureMember(shop, customer.id, profile);
  // Tagging a customer (e.g. "staff", "wholesale") excludes them. Removing the
  // tag does not re-include them, because staff may also exclude by hand.
  if (!member.excluded && isExcludedByTags(settings, customer.tags)) {
    await prisma.member.update({ where: { id: member.id }, data: { excluded: true } });
  }
  const state = customer.email_marketing_consent?.state;
  if (!rule.enabled || state !== "subscribed" || !settings.isLive) return { skipped: "no_reward" };
  const effects = [];
  await withMemberLock(member.id, (tx, locked) =>
    creditPoints(
      tx,
      locked,
      settings,
      { points: rule.points, type: "NEWSLETTER", key: `newsletter:${locked.id}`, description: "Joined the newsletter" },
      effects,
    ),
  );
  await runEffects(shop, effects, admin);
  return { ok: true };
}

/**
 * Review reward (Judge.me webhook or Shopify Flow). Text reviews need the
 * minimum word count; a photo review earns the photo amount instead. If a
 * photo is added to an already-rewarded review, the difference is topped up.
 */
export async function awardReview(shop, { customerId, email, reviewId, body, hasPhoto, verifiedBuyer, published }) {
  const settings = await getSettings(shop);
  const text = settings.earnRules.review;
  const photo = settings.earnRules.photoReview;
  if (!text.enabled && !photo.enabled) return { skipped: "off" };
  if (published === false) return { skipped: "not_published" };
  if (text.requireVerifiedBuyer && verifiedBuyer === false) return { skipped: "not_verified_buyer" };
  if (wordCount(body) < text.minWords && !hasPhoto) return { skipped: "too_short" };

  let member = customerId ? await findMember(shop, customerId) : null;
  if (!member && email) {
    member = await prisma.member.findFirst({ where: { shop, email: String(email).toLowerCase() } });
  }
  if (!member) return { skipped: "unknown_customer" };

  const target = hasPhoto && photo.enabled ? photo.points : text.enabled ? text.points : 0;
  const effects = [];
  const res = await withMemberLock(member.id, async (tx, locked) => {
    const textKey = `review:${reviewId}`;
    const photoKey = `review-photo:${reviewId}`;
    const already = await tx.ledgerEntry.findMany({
      where: { shop, idempotencyKey: { in: [textKey, photoKey] } },
    });
    const given = already.reduce((s, e) => s + e.points, 0);
    if (given >= target) return { duplicate: true };
    const key = given > 0 ? photoKey : textKey;
    return creditPoints(
      tx,
      locked,
      settings,
      {
        points: target - given,
        type: "REVIEW",
        key,
        description: hasPhoto ? "Photo review" : "Product review",
        meta: { reviewId },
      },
      effects,
    );
  });
  await runEffects(shop, effects);
  return res;
}

/** Starts Instagram follow verification: returns the code to DM to the brand account. */
export async function startInstagramVerification(shop, member) {
  const settings = await getSettings(shop);
  const rule = settings.earnRules.instagram;
  if (!rule.enabled) throw new LoyaltyError("IG_OFF", "Instagram rewards aren't running right now.");
  if (member.instagramId) return { verified: true, handle: member.instagramHandle };
  if (member.instagramCode) return { code: member.instagramCode, handle: rule.handle };
  for (let i = 0; i < 5; i++) {
    const code = `WD${randomCode(6)}`;
    try {
      await prisma.member.update({ where: { id: member.id }, data: { instagramCode: code } });
      return { code, handle: rule.handle };
    } catch (err) {
      if (err?.code !== "P2002") throw err;
    }
  }
  throw new Error("Could not allocate an Instagram code");
}

/**
 * Called from the Instagram messaging webhook after Meta confirms the sender
 * follows the brand. One Instagram account can only ever be linked once.
 */
export async function completeInstagramVerification(shop, code, { igsid, username }) {
  const settings = await getSettings(shop);
  const member = await prisma.member.findUnique({ where: { shop_instagramCode: { shop, instagramCode: code } } });
  if (!member) return { status: "unknown_code" };
  if (member.instagramId) return { status: "already_verified", member };
  const taken = await prisma.member.findUnique({ where: { shop_instagramId: { shop, instagramId: igsid } } });
  if (taken) return { status: "account_used", member };

  const effects = [];
  await withMemberLock(member.id, async (tx, locked) => {
    await tx.member.update({
      where: { id: locked.id },
      data: { instagramId: igsid, instagramHandle: username || null },
    });
    await creditPoints(
      tx,
      locked,
      settings,
      {
        points: settings.earnRules.instagram.points,
        type: "INSTAGRAM",
        key: `instagram:${locked.id}`,
        description: `Followed @${settings.earnRules.instagram.handle}`,
        meta: { username },
      },
      effects,
    );
  });
  await runEffects(shop, effects);
  return { status: "verified", member };
}

/** Staff adjustment from the admin. Negative amounts take points FIFO. */
export async function adjustPoints(shop, memberId, { points, reason, staff }, admin) {
  const settings = await getSettings(shop);
  const amount = Number.parseInt(points, 10);
  const note = String(reason || "").trim();
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000000) {
    throw new LoyaltyError("BAD_AMOUNT", "Enter a non-zero number of points.");
  }
  if (note.length < 3) throw new LoyaltyError("NO_REASON", "Add a reason so the history makes sense later.");
  const effects = [];
  const key = `adjust:${memberId}:${Date.now()}:${randomCode(4)}`;
  await withMemberLock(memberId, async (tx, member) => {
    if (member.shop !== shop) throw new LoyaltyError("NOT_FOUND", "Member not found.", 404);
    if (amount > 0) {
      await creditPoints(tx, member, settings, { points: amount, type: "ADJUSTMENT", key, description: note, createdBy: staff || "staff" }, effects);
    } else {
      await debitPoints(tx, member, { points: -amount, type: "ADJUSTMENT", key, description: note, createdBy: staff || "staff" }, effects);
    }
  });
  await runEffects(shop, effects, admin);
}

/** Generic earn event from Shopify Flow ("Send HTTP request") for custom campaigns. */
export async function awardCustomEvent(shop, { customerId, points, reason, key }) {
  const settings = await getSettings(shop);
  const member = await ensureMember(shop, customerId);
  const amount = Number.parseInt(points, 10);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw new LoyaltyError("BAD_AMOUNT", "points must be 1 to 100000");
  if (!key || String(key).length > 120) throw new LoyaltyError("BAD_KEY", "key is required (max 120 chars)");
  const effects = [];
  const res = await withMemberLock(member.id, (tx, locked) =>
    creditPoints(
      tx,
      locked,
      settings,
      { points: amount, type: "ADJUSTMENT", key: `flow:${key}`, description: String(reason || "Bonus points").slice(0, 120), createdBy: "flow" },
      effects,
    ),
  );
  await runEffects(shop, effects);
  return { duplicate: !!res.duplicate };
}
