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
  // Objective numbers come from the response's objective payload, not the model.
  assert.match(CLIENT, /objective\?\.sufficient/);
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

test("errors are recoverable — retry plus a way back to the games hub", () => {
  assert.match(CLIENT, /phase === "error"/);
  assert.match(CLIENT, /onRetry=\{load\}/);
  assert.match(CLIENT, /homeHref="\/casino"/);
});
