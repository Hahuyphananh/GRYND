import test from "node:test";
import assert from "node:assert/strict";
import { makeInitialMatch } from "../src/lib/precision/matchmaking.ts";
import {
  PRECISION_AI_USER_ID,
  cancelArming,
  isPrecisionAiMatch,
  precisionMatchStore,
  precisionPendingStops,
  recordRoundStop,
} from "../src/lib/precision/serverStore.ts";

test("Precision AI identity is explicit and cannot be mistaken for PvP", () => {
  const aiMatch = makeInitialMatch(
    "test-ai-match",
    0,
    [
      { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
      { seat: 2, userId: PRECISION_AI_USER_ID, name: "GRYND AI", isReady: true, isConnected: true },
    ],
    "ready_up",
    1,
    true,
  );
  const pvpMatch = { ...aiMatch, isAiGame: false };
  assert.equal(isPrecisionAiMatch(aiMatch), true);
  assert.equal(isPrecisionAiMatch(pvpMatch), false);
});

test("Precision AI stop uses the same server round-stop reducer", () => {
  const id = "test-ai-stop";
  const match = makeInitialMatch(
    id,
    0,
    [
      { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
      { seat: 2, userId: PRECISION_AI_USER_ID, name: "GRYND AI", isReady: true, isConnected: true },
    ],
    "active",
    1,
    true,
  );
  match.roundId = "m-test-ai-stop-r-1";
  match.roundNonce = "nonce-test";
  match.targetMs = 2500;
  match.roundGoInstant = Date.now() - 200;
  precisionMatchStore.set(id, match);
  precisionPendingStops.delete(id);

  const human = recordRoundStop(id, "human", match.roundId, match.roundNonce);
  const bot = recordRoundStop(id, PRECISION_AI_USER_ID, match.roundId, match.roundNonce);

  assert.equal(human.error, undefined);
  assert.equal(bot.error, undefined);
  assert.equal(bot.bothStopped, true);
  assert.equal(bot.match?.score.seat1 + bot.match?.score.seat2, 0);
  assert.equal(bot.match?.phase, "arming");

  cancelArming(id);
  precisionPendingStops.delete(id);
  precisionMatchStore.delete(id);
});
