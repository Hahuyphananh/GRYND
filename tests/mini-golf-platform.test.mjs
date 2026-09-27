// tests/mini-golf-platform.test.mjs
//
// Mini Golf's PLATFORM integration — the surfaces that are neither game rules
// nor competitive settlement (those live in tests/mini-golf-*.test.mjs):
//
//   * game discovery / registry  — it appears in the canonical catalog and the
//     casino lobby, in the same position, with tags, exactly once;
//   * active-game presence       — its gameLabel resolves to a canonical id, so
//     the "N playing" badge can count it;
//   * navigation                 — Games → Mini Golf → Lobby → Match → Result
//     → Games/Leaderboard, using only the existing routes and the shared
//     PvpResultScreen;
//   * metadata                   — page title + a description that states the
//     format (1v1 · turn-based · physics-based · best of 5 · first to 3);
//   * ad conventions             — a discovery/lobby page carries the script;
//     the match page does not.
//
// It deliberately asserts against the REAL sources and the REAL modules — no
// re-declared game lists — so a future refactor that drops Mini Golf from any
// of these surfaces fails here rather than in production.
//
// Run:  node --import tsx --test tests/mini-golf-platform.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { GAME_CATALOG, DEFAULT_GAME_ORDER } = await import("../src/lib/gameTags.js");
const {
  PRESENCE_GAME_IDS,
  isCanonicalGameId,
  isPresenceGame,
  resolveGameId,
} = await import("../src/lib/gamePresence.js");
const { recommendGames } = await import("../src/lib/gameRecommendations.js");

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const strip = (src) => src.replace(/\r\n/g, "\n");

const LOBBY = "src/app/casino/PageClient.jsx";
const LOBBY_PAGE = "src/app/casino/mini-golf/PageClient.tsx";
const MATCH_PAGE = "src/app/casino/mini-golf/[matchId]/PageClient.tsx";
const PAGE = "src/app/casino/mini-golf/page.tsx";
const COURSE = "src/components/mini-golf/MiniGolfCourse.tsx";
const PHYSICS = "src/lib/mini-golf/physics.ts";
const TRANSLATIONS = "src/lib/appTextTranslations.js";

const KEY = "mini-golf";

// ── 1. Game discovery / registry ─────────────────────────────────────────

test("discovery: mini-golf is in the canonical catalog with the lobby's href", () => {
  const entry = GAME_CATALOG.find((game) => game.id === KEY);
  assert.ok(entry, "mini-golf must be in GAME_CATALOG");
  assert.equal(entry.href, "/casino/mini-golf");
  assert.ok(entry.tags.includes("pvp"), "Mini Golf is a 1v1 duel → pvp");
  assert.ok(!entry.tags.includes("multiplayer"), "Mini Golf is strictly 2-player");
  // Exactly one entry — a duplicate would corrupt the fallback order.
  assert.equal(GAME_CATALOG.filter((game) => game.id === KEY).length, 1);
  assert.ok(DEFAULT_GAME_ORDER.includes(KEY));
});

test("discovery: the catalog and the lobby agree on Mini Golf's position", () => {
  const lobbyIds = [...strip(read(LOBBY)).matchAll(/leaderboardKey: "([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(GAME_CATALOG.length, lobbyIds.length, "catalog/lobby length mismatch");
  assert.deepEqual(
    GAME_CATALOG.map((game) => game.id),
    lobbyIds,
    "the catalog must mirror the lobby's featured order",
  );
  assert.equal(lobbyIds.at(-1), KEY, "Mini Golf is the newest lobby card");
});

test("discovery: the lobby card links to the Mini Golf lobby and records plays", () => {
  const src = strip(read(LOBBY));
  const card = src.slice(src.indexOf('name: "Mini Golf"'));
  assert.match(card, /href: "\/casino\/mini-golf"/);
  assert.match(card, /leaderboardKey: "mini-golf"/);
  assert.match(card, /playsKey: "mini-golf"/);
  assert.match(card, /pvpMode: "1v1"/);
  // The card art is the shipped Mini Golf image, not a shared fallback.
  assert.match(src, /import ImgMiniGolf from "\.\.\/\.\.\/images\/mini-golf-card\.svg"/);
});

test("discovery: personalization always returns Mini Golf (never hidden)", () => {
  const ranked = recommendGames({ game_types: ["pvp_duels"] }).recommendations.map(
    (game) => game.id,
  );
  assert.ok(ranked.includes(KEY));
  assert.equal(ranked.length, GAME_CATALOG.length);
});

// ── 2. Active-game presence ──────────────────────────────────────────────

test("presence: the mini-golf gameLabel resolves to the canonical id", () => {
  assert.ok(PRESENCE_GAME_IDS.includes(KEY), "canonical id must come from GAME_CATALOG");
  assert.equal(resolveGameId(KEY), KEY);
  assert.equal(resolveGameId("  MINI-GOLF  "), KEY, "labels are normalized");
  assert.equal(isPresenceGame(KEY), true);
  assert.equal(isCanonicalGameId(KEY), true);
});

test("presence: the match page reports through the shared host on its live edge", () => {
  const src = strip(read(MATCH_PAGE));
  assert.match(src, /<GameSessionHost\b/);
  assert.match(src, /gameLabel="mini-golf"/);
  // waiting rooms do not count: presence starts when the match is actually live…
  assert.match(src, /autoStart=\{match\.status === "playing"\}/);
  // …and stops (terminal) once the match is finished/cancelled.
  assert.match(src, /autoStop=\{finished \|\| cancelled\}/);
});

// ── 3. Navigation: Games → Lobby → Match → Result → Games/Leaderboard ────

test("navigation: the lobby entry route renders the Mini Golf lobby client", () => {
  const page = strip(read(PAGE));
  assert.match(page, /import PageClient from "\.\/PageClient"/);
  assert.match(page, /<PageClient \/>/);
  // The lobby client is the real one (create/join + practice entry points).
  const lobby = strip(read(LOBBY_PAGE));
  assert.match(lobby, /\/api\/mini-golf\/create-or-join/);
  assert.match(lobby, /\/api\/mini-golf\/create-ai/);
});

test("result: Mini Golf hands over to the shared result screen with its key", () => {
  const src = strip(read(MATCH_PAGE));
  assert.match(src, /import PvpResultScreen from "\.\.\/\.\.\/\.\.\/\.\.\/components\/result\/PvpResultScreen"/);
  assert.match(src, /<PvpResultScreen/);
  assert.match(src, /gameKey="mini-golf"/);
});

test("result: the shared screen routes back to Games and the rematch lobby", () => {
  const src = strip(read(MATCH_PAGE));
  // Play again → the Mini Golf lobby (same game, new match)…
  assert.match(src, /playAgain=\{\{ label: "Play again", onClick: \(\) => router\.push\("\/casino\/mini-golf"\) \}\}/);
  // …and return to the Games hub.
  assert.match(src, /onReturnToLobby=\{\(\) => router\.push\("\/casino"\)\}/);
});

test("result: Mini Golf appears in the per-game leaderboard picker", async () => {
  const { RATED_GAMES } = await import("../src/lib/rating.js");
  assert.ok(RATED_GAMES.includes(KEY), "the Elo board lists Mini Golf");
  const { listTrophyGames } = await import("../src/lib/trophyStore.js");
  assert.ok(
    listTrophyGames().some((game) => game.key === KEY),
    "the trophy board lists Mini Golf",
  );
  // /classement's client fallback must not drift from the registry.
  assert.match(strip(read("src/app/classement/PageClient.jsx")), /key: "mini-golf", label: "Mini Golf"/);
});

// ── 4. Metadata ──────────────────────────────────────────────────────────

test("metadata: the page title and description state the format", () => {
  const src = strip(read(PAGE));
  assert.match(src, /title: "Mini Golf \| GRYND"/);
  const description = /description:\s*"([^"]+)"/.exec(src)?.[1] ?? "";
  for (const trait of [/1v1/, /turn-based/, /physics-based/, /best of 5/i, /first to 3/i]) {
    assert.match(description, trait, `metadata description must mention ${trait}`);
  }
});

test("metadata: the lobby card copy also carries the format in every locale", () => {
  const src = strip(read(TRANSLATIONS));
  const lines = src.split("\n").filter((line) => line.includes("mini_golf_desc:"));
  assert.equal(lines.length, 3, "mini_golf_desc must exist for en/fr/es");
  for (const line of lines) {
    assert.match(line, /best of 5|au meilleur des 5|al mejor de 5/i);
    assert.match(line, /first to 3|premier à 3|primero en llegar a 3/i);
  }
});

// ── 5. Ad convention ─────────────────────────────────────────────────────

test("ads: the lobby page carries the ad script, the match page carries none", () => {
  assert.match(strip(read(PAGE)), /<AdSenseScript \/>/);
  assert.doesNotMatch(strip(read(MATCH_PAGE)), /AdSense|AdSlot/);
});

// ── 6. Shot interaction — Pool Masters parity ───────────────────────────
//
// Mini Golf deliberately uses the SAME aiming contract as the pool table:
// moving the pointer aims, a click locks the angle, then a drag charges power
// and its release launches the ball. The shoot button and the power slider are
// gone — reintroducing either would fork the game from every other 1v1 table
// on the platform.

test("interaction: the shoot button and the power slider are gone", () => {
  const src = strip(read(MATCH_PAGE));
  assert.doesNotMatch(src, /shoot-button/, "the shoot button must be gone");
  assert.doesNotMatch(src, /power-slider/, "the power slider must be gone");
  assert.doesNotMatch(src, /type="range"/, "no range input may drive the shot");
});

test("interaction: the match page drives the two-phase aim lock", () => {
  const src = strip(read(MATCH_PAGE));
  assert.match(src, /const \[aimLocked, setAimLocked\] = useState\(false\)/);
  assert.match(src, /onLock=\{\(\) => setAimLocked\(true\)\}/);
  assert.match(src, /onUnlock=\{\(\) => setAimLocked\(false\)\}/);
  assert.match(src, /onLaunch=\{\(next\) => void launchShot\(next\)\}/);
  assert.match(src, /data-testid="aim-state"/);
  // The only shot request is the canvas's launch callback.
  assert.equal((src.match(/\/shoot`, \{/g) ?? []).length, 1);
});

test("interaction: the canvas implements click-to-lock and drag-to-charge", () => {
  const src = strip(read(COURSE));
  // A locked angle draws the pool table's green guide; unlocked stays white.
  assert.match(src, /rgba\(74,222,128/, "locked aim must use the pool green");
  assert.match(src, /setLineDash\(\[7, 6\]\)/, "unlocked aim must use the pool dashed guide");
  // A click with no drag locks; a click while locked unlocks and re-aims.
  assert.match(src, /LOCK_CLICK_EPSILON/);
  assert.match(src, /onLock\?\.\(\)/);
  assert.match(src, /onUnlock\?\.\(\)/);
  assert.match(src, /onLaunch\?\.\(/);
});

// ── 7. Course rendering ────────────────────────────────────────────────

test("rendering: the visible hole is DERIVED, never a lagging copy", () => {
  const src = strip(read(MATCH_PAGE));
  assert.doesNotMatch(src, /const \[visibleHole/, "no visibleHole state may exist");
  assert.doesNotMatch(src, /setVisibleHole\(/, "nothing may write a separate hole copy");
  assert.match(src, /const viewHoleNumber =/);
  // The animating shot outranks the snapshot, so a server trajectory is always
  // drawn against the geometry it was actually simulated on.
  assert.match(src, /holeOverlay\?\.hole \?\? anim\?\.hole \?\?/);
});

test("rendering: presentation state is re-initialised when the match changes", () => {
  const src = strip(read(MATCH_PAGE));
  assert.match(src, /\}, \[matchId\]\);/, "a matchId-keyed reset effect must exist");
  assert.match(src, /hydratedRef\.current = false;/);
  assert.match(src, /lastAnimatedSeqRef\.current = -1;/);
  assert.match(src, /setRenderBalls\(null\);/);
});

test("rendering: a new rollout cancels any pending hole-result timer", () => {
  const src = strip(read(MATCH_PAGE));
  const clears = src.match(/clearTimeout\(overlayTimerRef\.current\)/g) ?? [];
  assert.ok(
    clears.length >= 3,
    `a stale result timer must be cleared on start, reset and unmount (found ${clears.length})`,
  );
});

test("ball art: the golf ball uses the Pool Masters rendering language", () => {
  const src = strip(read(COURSE));
  assert.match(src, /ctx\.ellipse\(/, "the pool ball's contact shadow");
  assert.match(src, /shadowBlur/, "the pool ball's depth blur");
  assert.match(src, /createRadialGradient/, "the pool ball's gloss gradient");
  assert.match(src, /ctx\.rotate\(roll\)/, "rolling dimples driven by travel");
  assert.match(src, /travelled/, "distance travelled must drive the roll");
  assert.match(src, /trail/, "a moving ball must leave a motion trail");
  assert.match(src, /sink/, "a holed ball must sink into the cup");
});

test("physics: the simulator runs the pass-through guard every substep", () => {
  assert.match(strip(read(PHYSICS)), /preventSegmentTunneling\(ball, prevPoint/);
});
