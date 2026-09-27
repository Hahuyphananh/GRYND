/**
 * Chess → Game Evaluation wiring.
 *
 * The finished chess result (the shared PvpResultScreen) now offers a "See
 * Evaluation" action that opens /evaluation/chess/[gameId]. These are static
 * checks (the page needs Clerk + a real match to mount) that pin the contract:
 *
 *   1. the extra action is a GENERIC panel feature (`secondaryAction`), not a
 *      chess-specific hack inside the panel — the panel knows nothing about
 *      chess or evaluation,
 *   2. it supports a navigation target (`href`) as well as an in-page action
 *      (`onClick`), so other games can reuse it later,
 *   3. chess passes it only for a FINISHED match (an expired match cannot be
 *      evaluated, so the button must not dead-end),
 *   4. no other game's result screen is touched in this pass.
 *
 * Run: node --import tsx --test tests/chess-evaluation-link.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

const PANEL = read("src/components/result/PvpResultScreen.jsx");
const CHESS = read("src/app/casino/chess-game/[gameId]/PageClient.jsx");

test("the shared panel exposes a generic secondaryAction (navigation or action)", () => {
  // Declared as an optional prop with a null default, like the other actions.
  assert.match(PANEL, /secondaryAction = null,/);

  // Navigation form: an internal route rendered through the router <Link>.
  assert.match(PANEL, /\{secondaryAction && secondaryAction\.href && \(/);
  assert.match(PANEL, /href=\{secondaryAction\.href\}/);

  // In-page form: a guarded button, consistent with playAgain/rematch.
  assert.match(PANEL, /\{secondaryAction && !secondaryAction\.href && \(/);
  assert.match(PANEL, /onClick=\{guard\(secondaryAction\.onClick\)\}/);

  // The actions block must gate on it, or it could never render.
  assert.match(PANEL, /\(playAgain \|\|[\s\S]{0,140}secondaryAction \|\|/);

  // The router link is imported (no raw <a href> that bypasses prefetch).
  assert.match(PANEL, /import Link from "next\/link"/);
});

test("the panel stays game-agnostic — no chess or evaluation knowledge inside it", () => {
  assert.doesNotMatch(PANEL, /chess/i, "the shared panel must not name a game");
  assert.doesNotMatch(PANEL, /evaluation/i, "the shared panel must not know about the evaluation feature");
  assert.doesNotMatch(PANEL, /\/evaluation\//, "the route belongs to the caller, not the panel");
});

test("chess's finished result offers See Evaluation → /evaluation/chess/[gameId]", () => {
  assert.match(CHESS, /secondaryAction=\{/);
  assert.match(CHESS, /label: "See Evaluation"/);
  assert.match(CHESS, /href: `\/evaluation\/chess\/\$\{gameId\}`/);
  // The link target is the shared evaluation page's real route shape.
  assert.match(CHESS, /\/evaluation\/chess\/\$\{gameId\}/);
});

test("the button is offered only for a finished match (expired cannot be evaluated)", () => {
  assert.match(
    CHESS,
    /gameData\.status === "finished"[\s\S]{0,160}\? \{ label: "See Evaluation"/,
  );
  // A non-finished match must resolve to null (hidden), never a dead link.
  assert.match(
    CHESS,
    /label: "See Evaluation", href: `\/evaluation\/chess\/\$\{gameId\}` \}\s*:\s*null/,
  );
});

test("only chess's result screen was changed in this pass", () => {
  const others = [
    "src/app/casino/mines-pvp/[matchId]/PageClient.tsx",
    "src/app/casino/keno-pvp/[matchId]/PageClient.jsx",
    "src/app/casino/rps/game/[gameId]/PageClient.tsx",
    "src/app/casino/four-in-a-row/game/[gameId]/PageClient.tsx",
    "src/app/casino/dots-and-boxes/game/[gameId]/PageClient.tsx",
    "src/app/casino/pool-masters/game/[matchId]/PageClient.tsx",
    "src/app/casino/roulette/[matchId]/PageClient.jsx",
    "src/app/casino/blackjack/[matchId]/PageClient.tsx",
    "src/app/casino/tower-arena/game/[matchId]/PageClient.tsx",
    "src/app/casino/plinko/[matchId]/PageClient.tsx",
    "src/app/casino/memory-grid/[matchId]/PageClient.tsx",
    "src/app/casino/lane-runner/[matchId]/PageClient.jsx",
    "src/app/casino/hex-duel/PageClient.tsx",
    "src/app/casino/dice-flush/PageClient.tsx",
    "src/app/casino/odds/PageClient.tsx",
    "src/app/casino/four-in-a-row/play-ai/PageClient.tsx",
    "src/app/casino/rps/play-ai/PageClient.tsx",
    "src/app/casino/chess/ai/ChessAIPageInner.tsx",
  ];
  for (const path of others) {
    assert.ok(
      !read(path).includes("secondaryAction="),
      `${path} must not pass secondaryAction yet`,
    );
  }
});
