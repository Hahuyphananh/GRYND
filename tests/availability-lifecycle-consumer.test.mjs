import test from "node:test";
import assert from "node:assert/strict";
import { availabilitySignalFromLifecycleEvent } from "../src/lib/availabilityLifecycleConsumer.ts";

test("converts a canonical lifecycle event into an availability signal", () => {
  const signal = availabilitySignalFromLifecycleEvent({
    eventId: "event-1",
    matchId: "match-1",
    eventType: "match.ready",
    payload: { status: "ready", game_key: "keno-pvp", mode: "pvp", player_count: 2, region: "eu" },
  });
  assert.deepEqual(signal, {
    gameKey: "keno-pvp",
    mode: "pvp",
    region: "eu",
    playerCount: 2,
    availabilityKey: "keno-pvp:pvp:eu:ready:match-1",
  });
});

test("ignores malformed lifecycle events", () => {
  assert.equal(availabilitySignalFromLifecycleEvent({ eventId: "e", matchId: "m", eventType: "match.ready", payload: {} }), null);
});
