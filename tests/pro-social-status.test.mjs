/**
 * pro-social-status.test.mjs
 *
 * GRYND PRO has to be VISIBLE. Every benefit shipped before this one was private
 * (no ads, more analysis, a queue tie-break), which is a hard thing to sell to a
 * competitive player: they pay because they love the game and want it to keep
 * running, and they want the room to know. This file guards the four pieces that
 * make the support legible:
 *
 *   1. THE MARK. A PRO account wears a badge next to its name on every
 *      leaderboard row and in chat. The label comes from the SERVER's own
 *      subscription read (src/lib/proStatus.ts) — never from the client — and a
 *      founder (subscribed inside the founding window) wears FOUNDER instead.
 *
 *   2. THE COSMETICS. Two signature PRO frames and two PRO tables are catalogue
 *      entries, and the server refuses them for a non-member. The rule that
 *      makes this safe to sell is the one tested most: EVERY OTHER cosmetic
 *      stays free, and the everyone-owns-everything grant skips only the
 *      `pro_only` rows.
 *
 *   3. THE OFFER. The visible benefit is advertised, and the plan row served by
 *      /api/membership/status carries it — a perk list that drifts from the
 *      catalog is how a retired claim stays on the price tag.
 *
 *   4. THE COPY. The offer's lead states the promise and the reasons to pay
 *      ("Master Your Game. Go deeper after every match…"), not the passive
 *      "compete without distractions" it replaced.
 *
 * Source-level by design: the restaurant test is that the enforcement is in the
 * server path, and the UI tests are that the surfaces render the component.
 *
 * Run:  node --import tsx --test tests/pro-social-status.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  FOUNDER_BADGE_LABEL,
  PRO_BADGE_LABEL,
  proBadgeFor,
} from "../src/lib/proStatus.ts";
import {
  ADVERTISED_PRO_BENEFIT_IDS,
  ADVERTISED_PRO_PERKS,
  PRO_BENEFIT_LABELS,
} from "../src/lib/proBenefits.ts";
import {
  BOARD_THEMES,
  boardThemeFor,
} from "../src/lib/solitaire-duel/boardThemes.ts";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
const exists = (path) => fs.existsSync(path);

const STATUS = "src/lib/proStatus.ts";
const BADGE = "src/components/ProBadge.tsx";
const LEADERBOARD = "src/lib/leaderboardQueries.js";
const CLASSEMENT = "src/app/classement/PageClient.jsx";
const COSMETICS = "src/lib/cosmetics.ts";
const EQUIP_ROUTE = "src/app/api/cosmetics/equip/route.ts";
const THEMES = "src/lib/solitaire-duel/boardThemes.ts";
const THEME_ROUTE = "src/app/api/solitaire/board-theme/route.ts";
const PICKER = "src/components/solitaire-duel/SolitaireThemePicker.tsx";
const CATALOG_MIGRATION = "src/db/migrations/0257_pro_social_status.sql";
const PERKS_MIGRATION = "src/db/migrations/0261_pro_offer_refresh.sql";

const CUTOFF = Date.parse("2026-06-01T00:00:00.000Z");

// ── 1. The mark ───────────────────────────────────────────────────────────

test("the badge label is decided from the subscription, and founders are recognised", () => {
  const founder = proBadgeFor("2026-01-15T12:00:00.000Z", CUTOFF);
  assert.equal(founder.founder, true);
  assert.equal(founder.label, FOUNDER_BADGE_LABEL);
  assert.match(founder.title, /founder/i);

  const later = proBadgeFor("2026-09-01T00:00:00.000Z", CUTOFF);
  assert.equal(later.founder, false);
  assert.equal(later.label, PRO_BADGE_LABEL);

  // No readable history is NOT a founder claim.
  assert.equal(proBadgeFor(null, CUTOFF).founder, false);
  assert.equal(proBadgeFor("not-a-date", CUTOFF).founder, false);
  // A Date instance works too (the query layer returns timestamps).
  assert.equal(proBadgeFor(new Date("2026-01-01T00:00:00Z"), CUTOFF).founder, true);
});

test("membership is resolved server-side in ONE batched query", () => {
  const status = code(STATUS);
  assert.match(status, /import \{ tokenSubscriptions \} from "\.\.\/db\/schema"/);
  assert.match(status, /ACTIVE_SUBSCRIPTION_STATUSES/);
  assert.match(status, /inArray\(tokenSubscriptions\.clerkId, unique\)/);
  // It never reads a client-supplied flag.
  assert.doesNotMatch(status, /headers\(|request|cookies\(|searchParams/);
  // The badge is decoration: no gate on a match, rating or result.
  assert.doesNotMatch(status, /applyMove|rating|elo/i);
});

test("the leaderboard attaches the badge per page and renders it", () => {
  const leaderboard = code(LEADERBOARD);
  assert.match(leaderboard, /import \{ getProClerkIds \} from "\.\/proStatus"/);
  assert.match(leaderboard, /async function attachProBadges/);
  // One call for the whole page, not one per row.
  assert.match(leaderboard, /getProClerkIds\(list\.map\(\(item\) => item\?\.clerk_id\)\)/);
  assert.match(leaderboard, /isPro: Boolean\(item\.clerk_id && members\.has\(String\(item\.clerk_id\)\)\)/);
  assert.match(leaderboard, /items: await attachProBadges\(await attachProfileFrames\(items\)\)/);

  const classement = read(CLASSEMENT);
  assert.match(classement, /import ProBadge from "\.\.\/\.\.\/components\/ProBadge"/);
  // Podium card and table row both wear it.
  assert.equal((classement.match(/<ProBadge\b/g) ?? []).length, 2);
  assert.match(classement, /\{item\.isPro && <ProBadge/);
});

test("the badge itself is presentational, accessible and honest", () => {
  const badge = code(BADGE);
  assert.match(badge, /data-testid="pro-badge"/);
  assert.match(badge, /data-founder=\{founder \? "true" : "false"\}/);
  assert.match(badge, /aria-label=\{accessibleTitle\}/);
  // No hooks and no entitlement check: the caller passes the server's answer.
  assert.doesNotMatch(badge, /useState|useEffect|localStorage|isProMember/);
  assert.match(badge, /supporting independent competitive gaming/i);
});

// ── 2. The cosmetics ──────────────────────────────────────────────────────

test("two PRO frames and two PRO tables exist, and are the only gated cosmetics", () => {
  const sql = read(CATALOG_MIGRATION);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "pro_only" BOOLEAN NOT NULL DEFAULT FALSE/);
  const keys = [...sql.matchAll(/'([a-z0-9_]+)',\n\s+'[^']*',\n\s+'[^']*',\n\s+'profile_frame'/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(keys.filter((key) => key.startsWith("pro_")), [
    "pro_founder_frame",
    "pro_supporter_frame",
  ]);
  // Neither is sold and neither is earned by play.
  assert.match(sql, /"price_tokens" = NULL/);
  assert.match(sql, /"unlock_condition" = NULL/);

  const proThemes = BOARD_THEMES.filter((theme) => theme.proOnly);
  assert.deepEqual(proThemes.map((theme) => theme.key), ["founder", "supporter"]);
  assert.equal(boardThemeFor("founder").proOnly, true);
  // Every free preset is untouched — the product rule the offer promises.
  assert.equal(BOARD_THEMES.filter((theme) => !theme.proOnly).length, 6);
});

test("a non-member is refused a PRO cosmetic, on the server", () => {
  const cosmetics = code(COSMETICS);
  assert.match(cosmetics, /if \(catalog\.proOnly\) \{/);
  assert.match(cosmetics, /if \(!options\.isPro\) \{/);
  assert.match(cosmetics, /error: "This is a GRYND PRO cosmetic\.",\s*\n\s*status: 403/);
  // Equipping IS the grant for these entries (they have no price and no
  // condition), and it is recorded so the ownership check passes afterwards.
  assert.match(cosmetics, /source: "pro"/);
  // The everyone-owns-everything grant skips ONLY the pro_only rows.
  assert.match(cosmetics, /WHERE c\."enabled" = TRUE AND c\."pro_only" = FALSE/);
  // The shop never offers a PRO entry for coins.
  assert.match(cosmetics, /eq\(cosmetics\.proOnly, false\)/);

  const route = code(EQUIP_ROUTE);
  assert.match(route, /const isPro = await isProMember\(userId\)/);
  assert.match(route, /equipCosmetic\(userId, body\?\.key, body\?\.category, \{ isPro \}\)/);
  assert.doesNotMatch(route, /body\?\.isPro|body\.isPro/);
});

test("a PRO table is enforced by the API and locked in the picker", () => {
  const route = code(THEME_ROUTE);
  assert.match(route, /boardThemeFor\(incoming\)\.proOnly && !\(await isProMember\(userId\)\)/);
  assert.match(route, /status: 403/);
  // GET tells the client whether the PRO tables are usable, and never serves a
  // PRO theme to an account that may no longer use it.
  assert.match(route, /const pro = await isProMember\(userId\)/);
  assert.match(route, /theme: usable/);

  const picker = code(PICKER);
  assert.match(picker, /option\.proOnly\) && !isPro/);
  assert.match(picker, /disabled=\{locked\}/);
  assert.match(picker, /data-pro-only=\{option\.proOnly \? "true" : undefined\}/);
  assert.match(picker, /GRYND PRO table/);
  // The lock reports the server's answer, not a client guess.
  assert.match(picker, /fetch\("\/api\/solitaire\/board-theme"/);
  assert.match(picker, /data\?\.pro === true/);
});

// ── 3. The offer ──────────────────────────────────────────────────────────

test("the visible benefit is advertised, labelled and on the plan row", () => {
  assert.ok(ADVERTISED_PRO_BENEFIT_IDS.includes("social_status"));
  assert.ok(PRO_BENEFIT_LABELS.social_status.length > 20);

  const sql = read(PERKS_MIGRATION);
  const array = sql.match(/"perks"\s*=\s*ARRAY\[([\s\S]*?)\]/);
  assert.ok(array, "the perks migration must set the array");
  const rowPerks = [...array[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
  assert.deepEqual(rowPerks, [...ADVERTISED_PRO_PERKS]);

  // The English bundle has the line the offer renders.
  const bundle = read("src/lib/appTextTranslations.js");
  assert.match(
    bundle,
    /social_status:\s*\n\s*"PRO Leaderboard Badge & Founder Flair/,
  );
});

test("the offer's lead sells the mission, not the absence of ads", () => {
  const bundle = read("src/lib/appTextTranslations.js");
  assert.match(
    bundle,
    /lead: "Master Your Game\. Go deeper after every match, track your climb across every title, and stand out on the ladder\."/,
  );
  assert.ok(!bundle.includes('lead: "Compete without distractions."'));
  // The other two locales carry the same promise.
  assert.match(
    bundle,
    /lead: "Maîtrise ton jeu\. Va plus loin après chaque partie, suis ta progression dans tous les jeux et démarque-toi au classement\."/,
  );
  assert.match(
    bundle,
    /lead: "Domina tu juego\. Profundiza después de cada partida, sigue tu ascenso en todos los juegos y destaca en la clasificación\."/,
  );
});

test("a member's collection grants the PRO frames so the picker can show them", () => {
  const cosmetics = code(COSMETICS);
  assert.match(cosmetics, /export async function grantProCosmetics/);
  assert.match(cosmetics, /WHERE c\."enabled" = TRUE AND c\."pro_only" = TRUE/);
  assert.match(cosmetics, /export async function getOwnedCosmetics\(\s*\n?\s*clerkId: string,\s*\n?\s*\{ isPro = false \}/);
  // Granted on READ, so the frames exist in the panel before the first equip.
  assert.match(cosmetics, /if \(isPro\) await grantProCosmetics\(appUser\.id\)/);

  const route = code("src/app/api/cosmetics/route.ts");
  assert.match(route, /const isPro = await isProMember\(userId\)/);
  assert.match(route, /getOwnedCosmetics\(userId, \{ isPro \}\)/);
  // A free account is not granted anything by the list route.
  assert.doesNotMatch(route, /body\.isPro|searchParams\.get\("isPro"\)/);
});

test("the journal registers both migrations, and the files exist", () => {
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const tags = journal.entries.map((entry) => entry.tag);
  for (const tag of ["0257_pro_social_status", "0258_pro_social_status_perks"]) {
    assert.ok(tags.includes(tag), `${tag} must be journaled`);
    const idx = tags.indexOf(tag);
    assert.equal(journal.entries[idx].idx, idx, "journal idx must equal its position");
    assert.ok(
      exists(`src/db/migrations/${tag}.sql`),
      `${tag} must have a .sql file`,
    );
  }
});
