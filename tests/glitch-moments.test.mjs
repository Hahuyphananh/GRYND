/**
 * glitch-moments.test.mjs
 *
 * Stage 4: GLITCH reacts to a finished match, and says one thing in the games
 * hub. Both are event-driven, both are bounded by the Stage 2 cadence rules,
 * and neither may be able to become an interruption.
 *
 * The things worth pinning are the ones a screenshot cannot prove:
 *
 *   1. COPY — every `glitch.*` line exists in en / fr / es and none of the
 *      result lines mentions a reward (the mascot must never imply one).
 *   2. MAPPING — win → victory, loss → defeat, anything else → idle; and the
 *      two lobby states produce different, stable event ids.
 *   3. NON-INTERFERENCE — the result block is inline inside the existing panel
 *      (no second overlay, nothing portalled), it is suppressed in Creator
 *      Mode and when a game supplies its own line, and the lobby uses the ONE
 *      floating provider rather than rendering its own mascot.
 *
 * Run: npm run test:glitch-moments
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { t } = await import("../src/lib/appTextTranslations.js");
const {
  glitchResultMoment,
  glitchLobbyMoment,
  selectGlitchResultReaction,
  GLITCH_RESULT_EVENT_IDS,
  GLITCH_MOMENT_KEYS,
  GLITCH_FORBIDDEN_RESULT_WORDS,
} = await import("../src/lib/mascot/glitchMoments.ts");

const read = (relPath) => fs.readFileSync(path.join(process.cwd(), relPath), "utf8");
const LOCALES = ["en", "fr", "es"];

const RESULT_SCREEN = "src/components/result/PvpResultScreen.jsx";
const LOBBY = "src/app/casino/PageClient.jsx";
const RPS_CLIENT = "src/app/casino/rps/play-ai/PageClient.tsx";

// ── Copy ──────────────────────────────────────────────────────────────────

test("every result and lobby line exists in all three locales", () => {
  for (const locale of LOCALES) {
    for (const key of GLITCH_MOMENT_KEYS) {
      const value = t(locale, key);
      assert.notEqual(value, key, `${locale} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${locale} has an empty ${key}`);
    }
  }
});

test("the English result and lobby copy matches the agreed wording", () => {
  assert.equal(t("en", "glitch.result.victory"), "That one's yours.");
  assert.equal(t("en", "glitch.result.defeat"), "Shake it off. Run it back.");
  assert.equal(t("en", "glitch.result.draw"), "All square. Go again.");
  assert.equal(t("en", "glitch.lobby.pickGame"), "Pick a game. I'll be watching.");
  assert.equal(t("en", "glitch.lobby.practiceFirst"), "Practice first. Brag later.");
});

test("no result line ever implies a reward", () => {
  for (const locale of LOCALES) {
    for (const key of ["glitch.result.victory", "glitch.result.defeat", "glitch.result.draw"]) {
      const line = t(locale, key).toLowerCase();
      for (const word of GLITCH_FORBIDDEN_RESULT_WORDS) {
        assert.ok(
          !line.includes(word.toLowerCase()),
          `${locale} ${key} promises "${word}" — the mascot cannot know that`
        );
      }
    }
  }
});

// ── Mapping ───────────────────────────────────────────────────────────────

test("the result expression follows the real outcome, with an idle fallback", () => {
  assert.equal(glitchResultMoment("win").expression, "victory");
  assert.equal(glitchResultMoment("win").messageKey, "glitch.result.victory");

  assert.equal(glitchResultMoment("loss").expression, "defeat");
  assert.equal(glitchResultMoment("loss").messageKey, "glitch.result.defeat");

  // Neutral / unexpected / missing → idle, never a celebration or a consolation.
  for (const neutral of ["draw", null, undefined, "", "resigned", "timeout"]) {
    const moment = glitchResultMoment(neutral);
    assert.equal(moment.expression, "idle", `outcome ${String(neutral)}`);
    assert.equal(moment.messageKey, "glitch.result.draw");
  }
});

// ── Selective visibility ──────────────────────────────────────────────────

test("a result reacts occasionally, not on every match", () => {
  const first = selectGlitchResultReaction({ outcome: "win" });
  assert.equal(first.show, true);
  assert.equal(first.reason, "occasional");
  assert.equal(first.moment.eventId, GLITCH_RESULT_EVENT_IDS.firstWin);

  // The same event later in the session is silent — no repeat reaction.
  const again = selectGlitchResultReaction(
    { outcome: "win" },
    { seenEventIds: [GLITCH_RESULT_EVENT_IDS.firstWin] }
  );
  assert.equal(again.show, false);
  assert.equal(again.reason, "duplicate");
});

test("the player's first rated match outranks every other reason", () => {
  const reaction = selectGlitchResultReaction({
    outcome: "loss",
    overallElo: { previousOverallElo: null, overallElo: 1180 },
    progress: [{ label: "Bronze", percent: 100 }],
    rankDelta: 4,
  });
  assert.equal(reaction.show, true);
  assert.equal(reaction.reason, "first-rated");
  assert.equal(reaction.moment.eventId, GLITCH_RESULT_EVENT_IDS.firstRated);
  assert.equal(reaction.moment.expression, "defeat");
});

test("an established rating is not a first match", () => {
  const reaction = selectGlitchResultReaction({
    outcome: "win",
    overallElo: { previousOverallElo: 1180, overallElo: 1192 },
  });
  assert.equal(reaction.reason, "occasional");
  assert.notEqual(reaction.moment.eventId, GLITCH_RESULT_EVENT_IDS.firstRated);
});

test("a completed tier and a rank climb are milestones with stable ids", () => {
  const tier = selectGlitchResultReaction({
    outcome: "win",
    progress: [{ label: "Silver", from: 60, to: 100, percent: 100 }],
  });
  assert.equal(tier.reason, "milestone");
  assert.equal(tier.moment.eventId, "result:milestone:silver");

  // A different tier is a different event, so the next promotion still speaks.
  const next = selectGlitchResultReaction(
    { outcome: "win", progress: [{ label: "Gold", percent: 100 }] },
    { seenEventIds: ["result:milestone:silver"] }
  );
  assert.equal(next.reason, "milestone");
  assert.equal(next.moment.eventId, "result:milestone:gold");

  const climb = selectGlitchResultReaction({ outcome: "loss", rankDelta: 3 });
  assert.equal(climb.reason, "rank-up");
  assert.equal(climb.moment.eventId, GLITCH_RESULT_EVENT_IDS.rankUp);
});

test("once every reason has been used, the result is silent", () => {
  const reaction = selectGlitchResultReaction(
    { outcome: "win", progress: [{ label: "Silver", percent: 100 }], rankDelta: 2 },
    {
      seenEventIds: [
        "result:milestone:silver",
        GLITCH_RESULT_EVENT_IDS.rankUp,
        GLITCH_RESULT_EVENT_IDS.firstWin,
      ],
    }
  );
  assert.equal(reaction.show, false);
  assert.equal(reaction.reason, "duplicate");
});

test("opt-out, Creator Mode and an unknown outcome never show", () => {
  const optedOut = selectGlitchResultReaction({ outcome: "win", showGlitch: false });
  assert.equal(optedOut.show, false);
  assert.equal(optedOut.reason, "opted-out");

  assert.equal(selectGlitchResultReaction({ outcome: "win", compact: true }).reason, "compact");
  assert.equal(selectGlitchResultReaction({ outcome: "abandoned" }).reason, "no-signal");
  assert.equal(selectGlitchResultReaction({}).show, false);
});

test("the ladder is deterministic — same signals, same answer", () => {
  const signals = { outcome: "win", progress: [{ label: "Silver", percent: 100 }] };
  assert.deepEqual(
    selectGlitchResultReaction(signals, { seenEventIds: [] }),
    selectGlitchResultReaction(signals, { seenEventIds: [] })
  );
});

test("the lobby picks one of two states, with distinct stable event ids", () => {
  const returning = glitchLobbyMoment(true);
  const newcomer = glitchLobbyMoment(false);

  assert.equal(returning.expression, "idle");
  assert.equal(returning.messageKey, "glitch.lobby.pickGame");
  assert.equal(returning.eventId, "lobby:has-history");

  assert.equal(newcomer.expression, "wink");
  assert.equal(newcomer.messageKey, "glitch.lobby.practiceFirst");
  assert.equal(newcomer.eventId, "lobby:no-history");

  // Different ids: a player can never be shown both in one session, and the
  // provider's dedupe stops a repeat of whichever one they saw.
  assert.notEqual(returning.eventId, newcomer.eventId);
});

// ── Result screen wiring ──────────────────────────────────────────────────

test("the result mascot is inline inside the existing panel, not a new overlay", () => {
  const source = read(RESULT_SCREEN);

  // Exactly one mascot render for one result event.
  assert.equal((source.match(/<GlitchSay/g) ?? []).length, 1);
  assert.match(source, /placement="inline"/);
  assert.match(source, /expression=\{glitchReaction\.moment\.expression\}/);
  assert.match(source, /message=\{t\(glitchReaction\.moment\.messageKey\)\}/);
  // Rendered only when the visibility ladder says so.
  assert.match(source, /showGlitch && !compact && glitchReaction\.show/);
  assert.match(source, /selectGlitchResultReaction\(/);

  // It is part of the panel's flow — no portal, no fixed layer of its own, no
  // dialog semantics, no second result surface.
  assert.doesNotMatch(source, /createPortal/);
  assert.doesNotMatch(source, /fixed inset-0[^"]*GlitchSay/);

  // Suppressed in Creator Mode recordings and when a game brings its own line,
  // so two mascots can never appear for one result.
  assert.match(source, /showGlitch && !compact/);
  assert.match(source, /showGlitch = true,/);
});

test("one reaction per event, remembered for the session only", () => {
  const source = read(RESULT_SCREEN);
  assert.match(source, /grynd:glitch:result-seen/);
  assert.match(source, /seenEventIds: readSeenGlitchResultEvents\(\)/);
  assert.match(
    source,
    /if \(glitchReaction\.show\) rememberGlitchResultEvent\(glitchReaction\.moment\.eventId\)/
  );
  // sessionStorage, never the server: no new column, no request, no backend.
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /fetch\("[^"]*glitch/);
});

test("a result never shows an inline and a floating mascot together", () => {
  const source = read(RESULT_SCREEN);
  // The result screen asks no floating layer at all — its bubble is inline,
  // and the floating one is suppressed by `[aria-modal="true"]` plus the
  // match-route rule in glitchCadence.js anyway.
  assert.doesNotMatch(source, /useGlitch\(/);
  assert.doesNotMatch(source, /<GlitchProvider/);
});

test("the result screen does not own any mascot cadence", () => {
  const source = read(RESULT_SCREEN);
  // No provider request from inside a result: the one floating layer must never
  // compete with the screen the player is looking at.
  assert.doesNotMatch(source, /useGlitch\(/);
  assert.doesNotMatch(source, /GlitchProvider/);
  // Timing still comes from the results module, not a literal here.
  assert.doesNotMatch(source, /onboarding\.glitch/);
});

test("the onboarding match opts out so it keeps exactly one mascot", () => {
  const source = read(RPS_CLIENT);
  assert.match(source, /showGlitch=\{false\}/);
  // …and still supplies its own tutorial line through the existing slot.
  assert.match(source, /extraContent=\{/);
});

// ── Lobby wiring ──────────────────────────────────────────────────────────

test("the lobby speaks through the one provider, never its own mascot", () => {
  const source = read(LOBBY);

  assert.match(source, /import \{ useGlitch \} from "\.\.\/\.\.\/components\/mascot\/GlitchProvider"/);
  assert.match(source, /const \{ say: glitchSay \} = useGlitch\(\)/);
  // No inline mascot in the lobby: it is a floating, corner, click-through
  // layer only, so it can never push or cover a game card.
  assert.doesNotMatch(source, /GlitchSay/);
  assert.doesNotMatch(source, /<GlitchProvider/);
});

test("the lobby hint is one-shot per session, deduped and gated", () => {
  const source = read(LOBBY);

  // Stable event id from the shared map — never a literal at the call site.
  assert.match(source, /eventId: moment\.eventId/);
  assert.doesNotMatch(source, /eventId: "lobby:/);
  // Priority 1 (an ordinary hint), so every cooldown applies to it.
  assert.match(source, /priority: 1,/);
  // One request per mount, and only an ACCEPTED hint is remembered — a declined
  // one must not consume the session's chance.
  assert.match(source, /const lobbyGlitchAskedRef = useRef\(false\)/);
  assert.match(source, /if \(!user \|\| firstBattle \|\| lobbyGlitchAskedRef\.current\) return;/);
  assert.match(source, /if \(accepted\) lobbyGlitchAskedRef\.current = true;/);
  // Silent while the first-battle card is the player's next step.
  assert.match(source, /firstBattle/);
});

test("the lobby hint adds no request and no storage of its own", () => {
  const source = read(LOBBY);
  const block = source.slice(
    source.indexOf("── GLITCH in the games hub"),
    source.indexOf("lobbyGlitchAskedRef.current = true;")
  );
  assert.ok(block.length > 0, "lobby GLITCH block not found");
  // Reuses the recently-played reader the hub already has.
  assert.match(block, /getPlayedGames\(\)\.length > 0/);
  assert.doesNotMatch(block, /fetch\(/);
  assert.doesNotMatch(block, /sessionStorage|localStorage/);
});

// ── Games that own their end panel ────────────────────────────────────────
//
// UNO draws its own end panel and Battleship ends inside its arena, so neither
// mounts PvpResultScreen. They must place the SAME mascot, from the SAME
// decision module — never a private Glitch and never a private line.

const OWN_END_PANELS = [
  "src/app/casino/uno/game/[gameId]/PageClient.jsx",
  "src/components/games/battleship/BattlePreview.tsx",
];

test("games with their own end panel mount the shared result mascot", () => {
  for (const file of OWN_END_PANELS) {
    const source = read(file);
    assert.match(source, /<GlitchSay/, `${file} does not render GLITCH`);
    assert.match(source, /glitchResultMoment\(/, `${file} decides its own moment`);
    assert.match(source, /expression=\{\w+\.expression\}/);
    assert.match(source, /message=\{t\(\w+\.messageKey\)\}/);
    assert.match(source, /placement="inline"/);
    assert.match(source, /eventId=\{\w+\.eventId\}/);
  }
});
