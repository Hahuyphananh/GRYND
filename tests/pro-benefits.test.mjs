/**
 * GRYND PRO — the offer must only advertise what the membership really grants.
 *
 * The membership used to be sold on four hand-kept copies of the same list (the
 * upgrade page's fixed keys, the fallback perk constants, the plan row in the
 * database, the Stripe product description), which is how a retired perk stays
 * on the price tag. They now all derive from ONE catalog
 * (src/lib/proBenefits.ts), and this file guards the two rules that keep the
 * offer honest:
 *
 *   1. AVAILABILITY — a benefit may be advertised only while the entitlement
 *      behind it is enforced server-side. The approved-but-unbuilt benefits
 *      (statistics/analytics graphs, extended leaderboards with progression
 *      graphs, private custom rooms) are recorded and translated, but they must
 *      NOT appear on the offer until the change that ships them flips them to
 *      `available` — and that change also has to add them to the enforcement map
 *      below, which fails until it does.
 *
 *   2. NO RETRACTED CLAIMS — profile customization (chat colour, accent) and
 *      priority support are not sold, and detailed match history does not
 *      exist. None of them may reappear in the copy a customer reads.
 *
 * It also pins the FREE-CUSTOMIZATION decision end to end, because the copy
 * promises it: "free for everyone" is only true if the write routes dropped
 * their membership check AND the read paths stopped hiding the colour from
 * non-members (a picker that saves a value nobody renders is worse than a gate).
 *
 * Run: node --import tsx --test tests/pro-benefits.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ADVERTISED_PRO_BENEFIT_IDS,
  ADVERTISED_PRO_BENEFITS,
  ADVERTISED_PRO_PERKS,
  PLANNED_PRO_BENEFIT_IDS,
  PRO_BENEFIT_IDS,
  PRO_BENEFIT_LABELS,
  PRO_BENEFITS,
  RETRACTED_PRO_CLAIMS,
  proBenefitIds,
} from "../src/lib/proBenefits.ts";
import { PRO_PLAN_FALLBACK_PERKS } from "../src/lib/membershipDisplay.ts";

const read = (path) => fs.readFileSync(path, "utf8");

/** The approved benefits that are enforced today, and WHERE they are enforced. */
const ENFORCEMENT = {
  ad_free: "src/lib/adEntitlement.ts",
  matchmaking: "src/lib/quickQueueWorker.ts",
};

/** Claims that must never come back to a customer-facing surface. */
const RETRACTED = /custom chat|chat color|profile accent|accent color|priority support|detailed match history|match history/i;

test("only enforced benefits are advertised", () => {
  for (const benefit of ADVERTISED_PRO_BENEFITS) {
    const enforcement = ENFORCEMENT[benefit.id];
    assert.ok(
      enforcement,
      `"${benefit.id}" is advertised but has no server-side enforcement site — ` +
        "add the entitlement first, then advertise it",
    );
    assert.ok(
      fs.existsSync(enforcement),
      `${benefit.id} points at ${enforcement}, which does not exist`,
    );
  }

  assert.deepEqual(
    ADVERTISED_PRO_BENEFIT_IDS,
    Object.keys(ENFORCEMENT),
    "the advertised and enforced sets must not drift",
  );
});

test("the approved-but-unbuilt benefits are catalogued, translated and NOT advertised", () => {
  assert.deepEqual(
    [...PLANNED_PRO_BENEFIT_IDS],
    ["analytics", "leaderboards", "private_rooms"],
  );

  for (const id of PLANNED_PRO_BENEFIT_IDS) {
    assert.ok(!ADVERTISED_PRO_BENEFIT_IDS.includes(id), `${id} must not be advertised yet`);
    // Recorded with its wording, so the surface that ships it only flips a flag.
    assert.ok(PRO_BENEFIT_LABELS[id]?.length > 0, `${id} needs approved wording`);
    assert.ok(
      !PRO_PLAN_FALLBACK_PERKS.includes(PRO_BENEFIT_LABELS[id]),
      `${id} must not reach a perk list before it ships`,
    );
  }

  // The two sets partition the catalog, and each keeps the catalog's display
  // order — a benefit cannot be dropped from one side (or reordered) by accident.
  assert.deepEqual(
    [...ADVERTISED_PRO_BENEFIT_IDS, ...PLANNED_PRO_BENEFIT_IDS].sort(),
    [...PRO_BENEFIT_IDS].sort(),
    "advertised + planned must be exactly the approved catalog",
  );
  for (const ids of [ADVERTISED_PRO_BENEFIT_IDS, PLANNED_PRO_BENEFIT_IDS]) {
    assert.deepEqual(
      [...PRO_BENEFIT_IDS].filter((id) => ids.includes(id)),
      [...ids],
      "each set must stay in the catalog's display order",
    );
  }
});

test("proBenefitIds() defaults to the advertised set", () => {
  assert.deepEqual(proBenefitIds(), [...ADVERTISED_PRO_BENEFIT_IDS]);
  assert.deepEqual(proBenefitIds("planned"), [...PLANNED_PRO_BENEFIT_IDS]);
  assert.equal(PRO_BENEFITS.length, PRO_BENEFIT_IDS.length);
});

test("the copy a customer reads carries no retracted claim", () => {
  // The perk lines themselves (rendered by the widget, written onto the plan
  // row by migration 0215, and published as the Stripe product description).
  for (const perk of ADVERTISED_PRO_PERKS) {
    assert.ok(!RETRACTED.test(perk), `retracted claim in the offer copy: "${perk}"`);
  }

  // …and the Stripe product copy is built from exactly those lines.
  const subscriptions = read("src/lib/stripe/subscriptions.ts");
  const description = subscriptions.match(
    /const PLAN_PRODUCT_DESCRIPTION = `([^`]*)`/,
  );
  assert.ok(description, "the Stripe product description must be derived from the catalog");
  assert.match(description[1], /\$\{ADVERTISED_PRO_PERKS\.join/);
  assert.ok(
    !RETRACTED.test(description[1].replace(/\$\{[^}]*\}/g, " ")),
    "the Stripe product description must not carry a retracted claim",
  );

  // Every retraction is justified — an undocumented removal comes back.
  for (const { claim, reason } of RETRACTED_PRO_CLAIMS) {
    assert.ok(claim.length > 0 && reason.length > 0, "a retraction needs a reason");
    assert.ok(RETRACTED.test(claim), `"${claim}" is not covered by the copy guard`);
  }
});

test("the offered perk row and the served plan row cannot drift", () => {
  // /api/membership/status serves `plan.perks` straight from the database, so
  // the migration's ARRAY must equal the catalog's advertised perks, item for
  // item and in order. Comments are stripped first: the migration deliberately
  // names the claims it removes.
  const sql = read("src/db/migrations/0215_pro_benefit_copy.sql")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const array = sql.match(/"perks"\s*=\s*ARRAY\[([\s\S]*?)\]/);
  assert.ok(array, "migration 0215 must set the grynd-pro perks array");

  const rowPerks = [...array[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
  assert.deepEqual(rowPerks, [...ADVERTISED_PRO_PERKS]);

  // The cold/failed plan read falls back to the same lines.
  assert.deepEqual([...PRO_PLAN_FALLBACK_PERKS], [...ADVERTISED_PRO_PERKS]);
});

test("profile customization is free for everyone in every supported language", async () => {
  const { t } = await import("../src/lib/appTextTranslations.js");

  for (const lang of ["en", "fr", "es"]) {
    for (const key of ["profile.chatcolor.note", "profile.customization.note"]) {
      const value = t(lang, key);
      assert.ok(
        typeof value === "string" && value.length > 0 && value !== key,
        `${lang} is missing ${key}`,
      );
      assert.match(
        value,
        /free|gratuit|gratis/i,
        `${key} must state the feature is free in ${lang}`,
      );
    }
  }

  // No surface may still call customization a membership perk. Comments are
  // stripped first — the code documents WHY the perk wording was removed, and
  // that documentation is the audit trail, not customer copy.
  const stripped = read("src/app/profil/PageClient.jsx")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.ok(
    !/GRYND PRO perk|GRYND PRO Membership/i.test(stripped),
    "the profile screen must not advertise customization as a PRO perk",
  );
  for (const locked of [
    "Unlock custom chat colors",
    "Customize your profile with a GRYND PRO membership",
  ]) {
    assert.ok(!stripped.includes(locked), `the locked branch is gone: "${locked}"`);
  }
  assert.ok(
    !/profile\.membership\.locked|profile\.customization\.locked/.test(stripped),
    "the profile screen no longer renders the locked-upgrade copy",
  );
});

test("the customization APIs no longer require a membership", () => {
  const chatColor = read("src/app/api/user/chat-color/route.ts");
  const customization = read("src/app/api/user/profile-customization/route.ts");

  for (const [name, source] of [
    ["chat-color", chatColor],
    ["profile-customization", customization],
  ]) {
    assert.ok(
      !/isPremiumMember/.test(source),
      `${name} must not gate on a membership any more`,
    );
    // Authentication is NOT relaxed — a caller still writes only their own row.
    assert.match(source, /await auth\(\)/, `${name} must stay auth-required`);
    assert.match(source, /eq\(users\.clerkId, userId\)/, `${name} must scope the write to the caller`);
  }
});

test("no read path hides the custom colour from a non-member", () => {
  // These four are where a saved colour becomes a rendered one (chat feed,
  // live socket message, in-game seats). Suppressing it for free accounts would
  // make the picker a silent no-op, so the membership condition is gone — and
  // the token-subscription join that existed only to compute it with it.
  const chat = read("src/app/api/chat/messages/route.js");
  assert.ok(
    !/premium \? \((msg|appUser)\??\.?chatColor/.test(chat),
    "the chat feed must not hide the colour from non-members",
  );
  assert.match(chat, /chatColor: glowColor \|\| \(msg\.chatColor \|\| null\)/);

  for (const path of [
    "src/app/api/dice-flush/state/route.js",
    "src/app/api/precision/get-match/route.ts",
    "src/app/api/get-user-tokens/route.ts",
  ]) {
    const source = read(path);
    assert.ok(!/isPremium/.test(source), `${path} still gates the colour on a membership`);
    assert.ok(
      !/tokenSubscriptions/.test(source),
      `${path} still joins subscriptions for a value nothing uses`,
    );
    assert.match(source, /chatColor/, `${path} must still resolve the colour`);
  }

  // The colour is still overridable by an equipped glow, everywhere.
  assert.match(read("src/app/api/dice-flush/state/route.js"), /row\.glowColor \|\| row\.chatColor/);
  assert.match(read("src/app/api/precision/get-match/route.ts"), /row\.glowColor \|\| row\.chatColor/);
  assert.match(read("src/app/api/get-user-tokens/route.ts"), /nameColor: user\.glowColor \|\| user\.chatColor/);
});
