// tests/guest-post-match-cta.test.mjs
//
// Phase 5 — the guest post-match account invitation.
//
// What is under test:
//
//   1. The pure DISPLAY RULES: a guest who finishes a supported match is
//      invited (AI and PvP alike); an authenticated account never is; an
//      unfinished/cancelled result never is; a dismissal and a missing guest
//      record both hide it.
//   2. The WIRING: the one shared component is mounted on the shared result
//      screen and on Battleship's own end card — the four games whose guest
//      practice results are actually persisted — and nowhere during play.
//   3. The CONVERSION PATH: both buttons are the existing Clerk routes ending
//      at the existing post-auth handoff (/sync → /welcome/claim), the guest
//      session is never touched from the client, and the card itself never
//      claims, writes, or mints an identity.
//   4. The COPY: every `guestProgress.postMatch.*` key exists in EN, FR and ES.
//
//   npm run test:guest-post-match

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  GUEST_POST_MATCH_CTA_NEXT,
  guestPostMatchCtaHrefs,
  guestPostMatchCtaKey,
  shouldShowGuestPostMatchCta,
  supportsGuestProgress,
} from "../src/lib/guest/postMatchCta.ts";
import { GUEST_GAME_LABELS } from "../src/lib/guest/guestProgressView.ts";
import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
/** Source without comments, so prose about "no claim" never satisfies a check. */
const code = (relative) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const CTA = "src/components/guest/GuestPostMatchCta.tsx";
const RULES = "src/lib/guest/postMatchCta.ts";
const RESULT_SCREEN = "src/components/result/PvpResultScreen.jsx";
const BATTLE_PREVIEW = "src/components/games/battleship/BattlePreview.tsx";
const GUEST_WRITER = "src/lib/guest/practiceProgress.ts";
const SYNC = "src/app/sync/PageClient.tsx";
const CLAIM_PANEL = "src/components/guest/GuestClaimPanel.tsx";
const CLAIM_ROUTE = "src/app/api/guest/claim/route.ts";

/** One finished practice match for a supported game, seen by a guest. */
const GUEST_FINISHED = {
  isLoaded: true,
  isSignedIn: false,
  matchFinished: true,
  gameKey: "dominoes",
  guestSession: "present",
  dismissed: false,
  compact: false,
};

const GAME_PAGES = {
  "tic-tac-toe": "src/app/casino/tic-tac-toe/[matchId]/PageClient.tsx",
  dominoes: "src/app/casino/dominoes/[matchId]/PageClient.tsx",
  odds: "src/app/casino/odds/game/[matchId]/PageClient.tsx",
};

// ── 1. Display rules ────────────────────────────────────────────────────────

test("a guest who finishes an AI match is invited", () => {
  assert.equal(shouldShowGuestPostMatchCta(GUEST_FINISHED), true);
  // The rule never looks at who the opponent was: an AI practice match and a
  // PvP match reach the same finished result screen and both qualify.
  assert.equal(
    shouldShowGuestPostMatchCta({ ...GUEST_FINISHED, gameKey: "tic-tac-toe" }),
    true,
  );
});

test("a guest who finishes a PvP match is invited too", () => {
  // Nothing in the inputs describes an opponent; a PvP result is the same
  // finished match shape, so the invitation is not AI-only.
  for (const gameKey of ["tic-tac-toe", "dominoes", "battleship", "odds"]) {
    assert.equal(
      shouldShowGuestPostMatchCta({ ...GUEST_FINISHED, gameKey }),
      true,
      `${gameKey} must invite a guest`,
    );
  }
});

test("an authenticated account never sees the invitation", () => {
  assert.equal(shouldShowGuestPostMatchCta({ ...GUEST_FINISHED, isSignedIn: true }), false);
  // A converted guest is signed in, so this is also the "already converted" rule.
  assert.equal(
    shouldShowGuestPostMatchCta({ ...GUEST_FINISHED, isSignedIn: true, guestSession: "present" }),
    false,
  );
  // Identity not resolved yet: never guess.
  assert.equal(shouldShowGuestPostMatchCta({ ...GUEST_FINISHED, isLoaded: false }), false);
});

test("an unfinished, cancelled or loading result shows nothing", () => {
  assert.equal(
    shouldShowGuestPostMatchCta({ ...GUEST_FINISHED, matchFinished: false }),
    false,
  );
  // A Creator Mode recording frame is not a result screen either.
  assert.equal(shouldShowGuestPostMatchCta({ ...GUEST_FINISHED, compact: true }), false);
});

test("a visitor with no guest record is not invited", () => {
  assert.equal(
    shouldShowGuestPostMatchCta({ ...GUEST_FINISHED, guestSession: "pending" }),
    false,
  );
  assert.equal(
    shouldShowGuestPostMatchCta({ ...GUEST_FINISHED, guestSession: "absent" }),
    false,
  );
  // A game that does not persist guest progress would make the card a lie.
  assert.equal(
    shouldShowGuestPostMatchCta({ ...GUEST_FINISHED, gameKey: "chess" }),
    false,
  );
  assert.equal(
    shouldShowGuestPostMatchCta({ ...GUEST_FINISHED, gameKey: undefined }),
    false,
  );
});

test("dismissing hides it for that match only", () => {
  assert.equal(shouldShowGuestPostMatchCta({ ...GUEST_FINISHED, dismissed: true }), false);

  const first = guestPostMatchCtaKey({
    gameKey: "dominoes",
    matchId: "match-1",
    pathname: "/casino/dominoes/match-1",
  });
  // The same match re-rendered or remounted resolves the same key, so a second
  // invitation cannot appear for one finished game.
  assert.equal(
    first,
    guestPostMatchCtaKey({
      gameKey: "dominoes",
      matchId: "match-1",
      pathname: "/casino/dominoes/match-1",
    }),
  );
  // A different match (or another game) is a different invitation.
  assert.notEqual(
    first,
    guestPostMatchCtaKey({ gameKey: "dominoes", matchId: "match-2" }),
  );
  assert.notEqual(first, guestPostMatchCtaKey({ gameKey: "odds", matchId: "match-1" }));
  // A board with no route id still gets a stable, match-scoped key.
  assert.equal(
    guestPostMatchCtaKey({ gameKey: "battleship", pathname: "/casino/battleship" }),
    guestPostMatchCtaKey({ gameKey: "battleship", pathname: "/casino/battleship" }),
  );
});

// ── 2. The supported-game list cannot drift ─────────────────────────────────

test("only the games whose guest results are persisted are invited", () => {
  const writer = read(GUEST_WRITER);
  const serverKeys = [...writer.matchAll(/export const GUEST_PRACTICE_[A-Z_]*GAME_KEY = "([a-z0-9-]+)"/g)]
    .map((match) => match[1])
    .sort();

  assert.ok(serverKeys.length >= 4, `expected the server key list, got ${serverKeys}`);
  assert.deepEqual(Object.keys(GUEST_GAME_LABELS).sort(), serverKeys);

  for (const key of serverKeys) assert.equal(supportsGuestProgress(key), true);
  assert.equal(supportsGuestProgress("chess"), false);
  assert.equal(supportsGuestProgress(null), false);
});

// ── 3. Wiring: the shared result screen + Battleship's own end card ────────

test("the invitation is mounted once, on the shared result screen", () => {
  const screen = code(RESULT_SCREEN);

  assert.match(screen, /import GuestPostMatchCta from "\.\.\/guest\/GuestPostMatchCta";/);
  // Opted in per game through one prop.
  assert.match(screen, /guestGameKey = null,/);
  assert.match(screen, /<GuestPostMatchCta\s+gameKey=\{guestGameKey\}\s+matchFinished=\{revealed\}/);
  // Never in a compact Creator Mode frame.
  // ...and NOT on the portal surface (/play/<gameKey>): a games portal forbids
  // an external account system, so the account invitation is absent there.
  assert.match(screen, /!compact && !portalSurface && guestGameKey/);
  assert.match(screen, /const portalSurface = isPortalPlayPath\(usePathname\(\)\);/);
  // Only inside the revealed result panel — i.e. after a real, finished match.
  assert.ok(
    screen.indexOf("guestGameKey ? (") > screen.indexOf("{revealed && ("),
    "the invitation must be inside the revealed result overlay",
  );
  // Below the actions and before the post-match ad: it cannot stand between the
  // player and their exit, and it cannot cover the result.
  assert.ok(
    screen.indexOf("<GuestPostMatchCta") > screen.indexOf("{/* Actions */}"),
    "the invitation must sit below the action buttons",
  );
  assert.ok(
    screen.indexOf("<GuestPostMatchCta") < screen.indexOf("<PostMatchAdSlot"),
    "the invitation must come before the post-match ad",
  );
});

test("every guest-progression game offers the invitation", () => {
  for (const [gameKey, page] of Object.entries(GAME_PAGES)) {
    const source = read(page);
    assert.match(
      source,
      new RegExp(`<PvpResultScreen[\\s\\S]{0,4000}?guestGameKey="${gameKey}"`),
      `${page} must pass guestGameKey="${gameKey}"`,
    );
  }

  // Battleship draws its own end card, so it mounts the shared card itself.
  const battleship = read(BATTLE_PREVIEW);
  assert.match(battleship, /import GuestPostMatchCta from "\.\.\/\.\.\/guest\/GuestPostMatchCta";/);
  assert.match(battleship, /<GuestPostMatchCta\s+gameKey="battleship"\s+matchId=\{matchId\}\s+matchFinished=\{Boolean\(resultLabel\)\}/);

  // Games with no guest progression are untouched: they pass no key, so the
  // card is never mounted for them.
  for (const page of [
    "src/app/casino/hillstrike/play-ai/PageClient.tsx",
    "src/app/casino/four-in-a-row/play-ai/PageClient.tsx",
  ]) {
    assert.doesNotMatch(read(page), /guestGameKey/);
  }
});

// ── 4. Conversion: existing routes, existing claim, preserved session ──────

test("both buttons use the existing auth routes and the post-auth handoff", () => {
  const hrefs = guestPostMatchCtaHrefs();
  assert.equal(GUEST_POST_MATCH_CTA_NEXT, "/sync");
  assert.equal(hrefs.signUp, "/sign-up?redirect_url=%2Fsync");
  assert.equal(hrefs.signIn, "/sign-in?redirect_url=%2Fsync");

  // Those routes are the real ones already shipped.
  assert.ok(fs.existsSync(path.join(ROOT, "src/app/sign-up/[[...sign-up]]/page.jsx")));
  assert.ok(fs.existsSync(path.join(ROOT, "src/app/sign-in/[[...sign-in]]/page.jsx")));
});

test("the guest session survives the trip to registration and sign-in", () => {
  const cta = code(CTA);
  const rules = code(RULES);

  // Plain same-origin Next links: no window.location, no new tab, no cookie
  // handling anywhere on the client.
  assert.match(cta, /import Link from "next\/link";/);
  assert.match(cta, /href=\{signUp\}/);
  assert.match(cta, /href=\{signIn\}/);
  assert.doesNotMatch(cta, /document\.cookie|window\.location|location\.href/);
  assert.doesNotMatch(rules, /document\.cookie|window\.location/);
  // The destination is the handoff, never a claim request or a guest id.
  assert.doesNotMatch(cta, /guest_|localStorage/);
  assert.match(rules, /GUEST_POST_MATCH_CTA_NEXT = "\/sync"/);
});

test("the card converts through the existing Phase 4 claim, not a new one", () => {
  const cta = code(CTA);

  // The only network call is the read-only guest-progress lookup.
  const fetches = [...cta.matchAll(/fetch\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(fetches, ["/api/guest/progress"]);
  assert.doesNotMatch(cta, /method:\s*"POST"/);
  assert.match(cta, /credentials: "same-origin"/);
  assert.match(cta, /cache: "no-store"/);

  // The claim still has exactly one implementation, reached by /sync.
  assert.match(code(SYNC), /\/welcome\/claim\?next=/);
  assert.match(read(CLAIM_ROUTE), /claimGuestProgression/);
  assert.match(read(CLAIM_PANEL), /method: "POST"/);
  // The invitation never writes a guest row, so no second identity or record
  // can be produced by showing it.
  assert.doesNotMatch(cta, /guestProfiles|guestPracticeResults|guestClaims/);
});

// ── 5. Component behaviour that the rules imply ────────────────────────────

test("the requirement to be dismissible and non-blocking is built in", () => {
  const cta = code(CTA);

  assert.match(cta, /data-testid="guest-post-match-dismiss"/);
  assert.match(cta, /rememberGuestPostMatchCtaDismissed\(storageKey\)/);
  assert.match(cta, /readGuestPostMatchCtaDismissed\(storageKey\)/);
  // Session-scoped: a later visit may offer it again.
  assert.match(code(RULES), /sessionStorage/);
  // Inline section, not a modal: no dialog role, no focus trap, no backdrop.
  assert.match(cta, /<section/);
  assert.doesNotMatch(cta, /role="dialog"|aria-modal|fixed inset-0/);
  // Responsive: one column of full-width controls that fits a phone.
  assert.match(cta, /flex flex-col gap-2/);
  assert.match(cta, /w-full items-center justify-center/);
  // It states the account is free.
  assert.match(cta, /guestProgress\.postMatch\.free/);
});

test("the copy never claims progress was lost", () => {
  const bundle = APP_TEXT_TRANSLATIONS.en.guestProgress.postMatch;
  assert.equal(
    bundle.title,
    "Keep your progress. Create your GRYND account.",
  );
  assert.match(bundle.body, /already saved/);
  assert.doesNotMatch(bundle.body, /lost|expire|before it|save your progress/i);
  assert.equal(bundle.primary, "Create Free Account");
  assert.equal(bundle.secondary, "Already have an account? Sign in");
});

test("every post-match copy key exists in EN, FR and ES", () => {
  const cta = read(CTA);
  const keys = new Set(
    [...cta.matchAll(/t\(\s*"(guestProgress\.postMatch\.[A-Za-z0-9_.]+)"/g)].map(
      (match) => match[1],
    ),
  );
  assert.ok(keys.size >= 7, `expected the card's copy keys, got ${[...keys].join(", ")}`);

  const resolve = (bundle, key) => key.split(".").reduce((node, part) => node?.[part], bundle);
  for (const lang of ["en", "fr", "es"]) {
    const bundle = APP_TEXT_TRANSLATIONS[lang];
    assert.ok(bundle, `missing locale ${lang}`);
    for (const key of keys) {
      const value = resolve(bundle, key);
      assert.equal(typeof value, "string", `${lang} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});
