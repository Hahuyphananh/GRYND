/**
 * Game Evaluation page — contract guard for /evaluation/[gameKey]/[matchId].
 *
 * The page needs Clerk, a live API and a real match, so these are static checks
 * rather than mounted tests. They pin the contract that makes the page correct
 * and safe:
 *
 *   1. it is a shared page (game name comes from the shared rating labels) that
 *      calls the Prompt-3 evaluation API and nothing game-specific for the
 *      evaluation itself,
 *   2. a first call shows a loading state (the engine + model take seconds),
 *   3. a 429 is rendered as an upgrade prompt via the existing PRO flow, never
 *      as a raw error,
 *   4. AI output is rendered as TEXT — there is no dangerouslySetInnerHTML, so
 *      model output can never become HTML/JSX,
 *   5. every optional section is conditional (only rendered when present).
 *
 * Run: node --import tsx --test tests/evaluation-page.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const exists = (path) => fs.existsSync(path);

const PAGE = read("src/app/evaluation/[gameKey]/[matchId]/page.tsx");
const CLIENT = read("src/app/evaluation/[gameKey]/[matchId]/PageClient.tsx");

test("the shared evaluation page routes exist", () => {
  for (const path of [
    "src/app/evaluation/[gameKey]/[matchId]/page.tsx",
    "src/app/evaluation/[gameKey]/[matchId]/PageClient.tsx",
  ]) {
    assert.ok(exists(path), `${path} should exist`);
  }
});

test("the page is a thin server shell that renders the client with a shared game label", () => {
  // Metadata is generated server-side from the SAME shared labels the rating
  // boards use — never a hardcoded game name.
  assert.match(PAGE, /export async function generateMetadata/);
  assert.match(PAGE, /import \{ getRatingGameLabel \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/rating"/);
  assert.match(PAGE, /getRatingGameLabel\(gameKey\)/);
  assert.match(PAGE, /<PageClient gameLabel=/);
  // Personal match analysis must never be indexed.
  assert.match(PAGE, /robots: \{ index: false, follow: false \}/);
});

test("the page calls the Prompt-3 evaluation API on load, with no request body identity", () => {
  assert.match(
    CLIENT,
    /fetch\(\s*`\/api\/evaluation\/\$\{encodeURIComponent\(gameKey\)\}\/\$\{encodeURIComponent\(matchId\)\}`/,
  );
  assert.match(CLIENT, /method: "POST"/);
  // Identity is the session cookie; the server derives everything else.
  assert.match(CLIENT, /credentials: "include"/);
  assert.doesNotMatch(CLIENT, /body\s*:\s*JSON\.stringify/);
  // The match header is the ONLY game-specific fetch and it is a lookup map, so
  // adding a game is a one-line adapter (mirroring the server evaluator list).
  assert.match(CLIENT, /MATCH_HEADER_ENDPOINTS = \{/);
  assert.match(CLIENT, /\/api\/chess\/game-state\?gameId=/);
});

test("a first call shows a loading state while the analysis is generated", () => {
  assert.match(CLIENT, /phase === "loading"/);
  assert.match(CLIENT, /aria-busy="true"/);
  assert.match(CLIENT, /Analysing your match/);
  // The initial phase must be loading, so the page never flashes an empty state.
  assert.match(CLIENT, /useState\("loading"\)/);
  // The evaluation must run exactly once per match (guards dev strict mode).
  assert.match(CLIENT, /startedForRef/);
});

test("a 429 renders the existing upgrade flow, not a raw error", () => {
  assert.match(CLIENT, /res\.status === 429/);
  assert.match(CLIENT, /setPhase\("limit"\)/);
  assert.match(CLIENT, /phase === "limit"/);
  assert.match(CLIENT, /function LimitPanel/);
  // The upsell is the reusable PRO component (which owns the modal + Stripe).
  assert.match(CLIENT, /import UpgradeProButton from "\.\.\/\.\.\/\.\.\/\.\.\/components\/UpgradeProButton"/);
  assert.match(CLIENT, /<UpgradeProButton \/>/);
});

test("AI output is rendered as text — there is no HTML injection path", () => {
  assert.ok(
    !CLIENT.includes("dangerouslySetInnerHTML"),
    "model output must never be injected as HTML",
  );
  assert.ok(
    !PAGE.includes("dangerouslySetInnerHTML"),
    "the server shell must never inject HTML either",
  );
  // The summary + list items are rendered as React text children.
  assert.match(CLIENT, /\{insight\.summary\}/);
  assert.match(CLIENT, /<span>\{String\(item\)\}<\/span>/);
  assert.match(CLIENT, /<p[^>]*>\s*\{insight\.next_time_tip\}\s*<\/p>/);
});

test("every optional evaluation section is conditional", () => {
  // Each section is guarded, so a response missing a category renders nothing
  // for it rather than an empty shell.
  assert.match(CLIENT, /insight\?\.summary \?/);
  assert.match(CLIENT, /strengths\.length > 0 \?/);
  assert.match(CLIENT, /weaknesses\.length > 0 \?/);
  assert.match(CLIENT, /keyMoments\.length > 0 \?/);
  assert.match(CLIENT, /improvements\.length > 0 \?/);
  assert.match(CLIENT, /insight\?\.next_time_tip \?/);
  // All five spec sections plus the summary are labelled.
  for (const heading of [
    "AI Evaluation",
    "Strengths",
    "Weaknesses",
    "Key Moments",
    "Improvements",
    "Next Time Tip",
  ]) {
    assert.ok(CLIENT.includes(heading), `the page should render the "${heading}" section`);
  }
});

test("an LLM outage still shows the objective stats with a fallback message", () => {
  assert.match(CLIENT, /AI analysis unavailable/);
  assert.match(CLIENT, /evaluation\.message/);
  // The AI caution card is shown only when an AI call was actually part of the
  // report — a performance report has no AI half, so it shows no such card.
  assert.match(CLIENT, /showAiUnavailableCard/);
  // Objective numbers come from the response's objective payload, not the model.
  assert.match(CLIENT, /chessPayload\?\.sufficient/);
  assert.match(CLIENT, /accuracyPercent/);
});

test("the page reuses the existing result/profile component conventions", () => {
  for (const component of [
    "components/navigation-bar",
    "components/Footer",
    "components/InteractiveCasinoBg",
    "components/FrameAvatar",
    "components/states/ErrorState",
    "components/states/StateShell",
  ]) {
    assert.ok(
      CLIENT.includes(component),
      `the page should reuse ${component}`,
    );
  }
  // The objective stats are derived per viewer colour from the game's own API.
  assert.match(CLIENT, /viewerRole/);
  assert.match(CLIENT, /deriveOutcome/);
  assert.match(CLIENT, /deriveOpponent/);
});

test("the match header labels full moves and plies in their own units", () => {
  // A 13-ply game is 7 moves. The page used to render the top-level `moveCount`
  // — which was the PLY count — as "moves played", so a 20-move game claimed
  // "40 moves played". The label is now built from `plyCount` through the shared
  // convention (see src/lib/evaluation/moveCounts.ts), which is also what keeps
  // rows cached BEFORE the fix displaying correctly: their `plyCount` is still
  // the ply count, and their `moveCount` is never trusted for the label.
  assert.match(
    CLIENT,
    /import \{ fullMoveCount \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/evaluation\/moveCounts"/,
  );
  assert.match(CLIENT, /function moveCountLabel\(/);
  assert.match(CLIENT, /fullMoveCount\(plies\)/);
  assert.ok(
    CLIENT.includes("moves played · ${plies} plies"),
    "the label must state both units explicitly",
  );
  assert.match(
    CLIENT,
    /\{moveCountLabel\(chessPayload\)\}/,
    "the header must use the label",
  );
  // The ply count must never be printed as a move count again.
  assert.ok(
    !/\{objective\.moveCount[^}]*\}[^<]*moves played/.test(CLIENT),
    "the header must not render moveCount as \"moves played\"",
  );
  // The label is built from the chess payload, which is the only shape that
  // carries `plyCount`.
  assert.match(CLIENT, /moveCountLabel\(chessPayload\)/);
  // The payload type carries both counts, documented.
  assert.match(CLIENT, /plyCount\?: number;/);
});

test("a 409 (analysis already in flight) uses the retryable error path", () => {
  // The service answers 409 `evaluation_in_progress` when a concurrent request
  // holds the claim for this match — the work is happening elsewhere, so the
  // right answer is the server's message plus Retry, NOT a second analysis.
  assert.match(CLIENT, /if \(!res\.ok \|\| !json\?\.success\)/);
  assert.match(CLIENT, /setErrorMessage\(\s*json\?\.error/);
  assert.match(CLIENT, /onRetry=\{load\}/);
  // Only 429 gets its own state; every other failure is the honest error path.
  assert.match(CLIENT, /res\.status === 429/);
});

test("errors are recoverable — retry plus a way back to the games hub", () => {
  assert.match(CLIENT, /phase === "error"/);
  assert.match(CLIENT, /onRetry=\{load\}/);
  assert.match(CLIENT, /homeHref="\/casino"/);
});

test("the chess payload keeps its own renderer, unchanged", () => {
  // Chess rows are the legacy shape, recognized by their own `sufficient` flag,
  // and rendered by the block that always rendered them.
  assert.match(CLIENT, /function isChessObjectivePayload/);
  assert.match(CLIENT, /chessPayload\?\.sufficient/);
  assert.match(CLIENT, /Match at a Glance/);
  assert.match(CLIENT, /moveCountLabel\(chessPayload\)/);
  // A report is routed to the report renderer only when it declares a schema
  // version — which the chess payload never has.
  assert.match(CLIENT, /looksLikeGameReportV1\(objective\)/);
});

test("a GameReportV1 is validated before rendering and uses its metrics/players", () => {
  assert.match(
    CLIENT,
    /from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/evaluation\/reportViewModel"/,
  );
  assert.match(CLIENT, /buildGameReportView/);
  assert.match(CLIENT, /reportViewHasContent/);
  // Validation happens first; a malformed report is never partially rendered.
  assert.match(CLIENT, /reportResult\.ok/);
  // Labels, values and units come from the validated report itself.
  assert.match(CLIENT, /<ReportMetrics metrics=\{report\.metrics\} \/>/);
  assert.match(CLIENT, /report\.players\.map\(/);
  assert.match(CLIENT, /<ReportMetrics metrics=\{player\.metrics\} \/>/);
  assert.match(CLIENT, /title=\{report\.title\}/);
  // An unmeasured metric is never printed as a number.
  assert.match(CLIENT, /Not recorded/);
  assert.match(CLIENT, /metric\.value === null/);
  // A performance report is never described as a chess/engine evaluation.
  assert.match(
    CLIENT,
    /"Deterministic performance metrics, computed from your match data\."/,
  );
});

test("no fallback claims statistics are shown below when none are rendered", () => {
  // The old unconditional sentence is gone. The claim is now conditional on
  // objective statistics actually being rendered below.
  assert.equal(
    /still computed from your game and are shown below\."/.test(CLIENT),
    false,
    "the fallback must not unconditionally claim statistics below",
  );
  assert.match(CLIENT, /hasObjectiveStats/);
});

test("absent, malformed, unavailable and cached reports each get a clear state", () => {
  // Absent/malformed/unsupported objective payloads say so explicitly.
  assert.match(CLIENT, /showUnreadableNotice/);
  assert.match(CLIENT, /Report unavailable/);
  assert.match(CLIENT, /couldn't be read, so its statistics are not shown/);
  assert.match(CLIENT, /reportErrors/);
  // An explicitly unavailable report states its reason.
  assert.match(CLIENT, /No report available/);
  assert.match(CLIENT, /report\.unavailableReason/);
  // A cached evaluation is still labelled as such.
  assert.match(CLIENT, /Saved evaluation/);
});
