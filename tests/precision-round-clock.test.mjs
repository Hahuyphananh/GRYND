// Precision — the running-timer display clock.
//
// The player times their STOP against the number on screen, but the number
// that decides the round is the server's `Date.now() - roundGoInstant`. These
// tests model both clocks explicitly (a server wall clock, a device wall clock
// that may be skewed, and a local monotonic clock) and check that the display
// counts from the same instant the server measures from — with none of the
// poll latency in it. The old behaviour (anchor on the moment the client
// noticed the round open) is computed alongside, so the regression is pinned
// as much as the fix.

import test from "node:test";
import assert from "node:assert/strict";

import {
  GO_DRIFT_TOLERANCE_MS,
  elapsedSince,
  pairScheduledGo,
  resolveRoundAnchorLocal,
} from "../src/lib/precision/roundClock.ts";

/**
 * One client's view of the world.
 *
 * @param serverNowMs server wall clock (`Date.now()` on the server)
 * @param skewMs      device wall clock minus server wall clock
 * @param monotonicOffsetMs local `performance.now()` minus the server clock
 *        (an arbitrary, fixed origin — only differences matter)
 */
const client = (serverNowMs, skewMs, monotonicOffsetMs) => ({
  deviceNow: () => serverNowMs + skewMs,
  perfNow: () => serverNowMs - monotonicOffsetMs,
});

test("the scheduled GO pairs to the same local instant however late it is observed", () => {
  // The round is armed at server t=1000 with a 5s countdown, so the scheduled
  // GO is server t=6000. Three clients read that arming state with wildly
  // different transport delays — the derived local instant of the GO must be
  // the same for all of them, which is what removes the poll lag from the
  // display.
  const ARM_START = 1000;
  const SCHEDULED_GO = ARM_START + 5000;
  const MONOTONIC_OFFSET = 700_000; // arbitrary perf-clock origin
  const expectedPerfGo = SCHEDULED_GO - MONOTONIC_OFFSET;

  for (const delay of [5, 120, 400]) {
    const observedAtServer = ARM_START + delay;
    const c = client(observedAtServer, 0, MONOTONIC_OFFSET);
    const pairing = pairScheduledGo({
      countdownEndsAt: SCHEDULED_GO,
      roundSequence: 3,
      localNowMs: c.perfNow(),
      deviceNowMs: c.deviceNow(),
    });
    assert.equal(
      pairing.localMs,
      expectedPerfGo,
      `a ${delay}ms-late read must still resolve the GO to the same local instant`,
    );
    assert.equal(pairing.roundSequence, 3);
    assert.equal(pairing.serverMs, SCHEDULED_GO);
  }
});

test("the reveal's drift is carried over, so the display matches the server's clock", () => {
  // A round opens on the first read past its countdown, so the actual GO can
  // land after the scheduled end. That drift is a difference of two SERVER
  // stamps, so it must be added exactly.
  const SCHEDULED_GO = 6000;
  const GO = 6250; // 250ms of reveal latency
  const MONOTONIC_OFFSET = 700_000;
  const c = client(GO + 150, 0, MONOTONIC_OFFSET); // observed 150ms after the GO
  const scheduled = pairScheduledGo({
    countdownEndsAt: SCHEDULED_GO,
    roundSequence: 4,
    localNowMs: c.perfNow() - 6000, // paired while arming, ~6s earlier
    deviceNowMs: c.deviceNow() - 6000,
  });

  const anchor = resolveRoundAnchorLocal({
    scheduled,
    goInstant: GO,
    roundSequence: 4,
    localNowMs: c.perfNow(),
    deviceNowMs: c.deviceNow(),
  });

  // The anchor is the local instant of the GO: 150ms ago, not "now".
  assert.equal(c.perfNow() - anchor, 150);
  assert.equal(elapsedSince(anchor, c.perfNow()), 150);
});

test("the display tracks the server's measurement, with no poll lag in it", () => {
  // Full round: armed at server 1000 (scheduled GO 6000), revealed 250ms late
  // at 6250 because the round opens on the next read. The client sees the
  // reveal 150ms after that, and clicks at server 8300 (2050ms after the GO).
  const ARM_START = 1000;
  const SCHEDULED_GO = 6000;
  const GO = 6250;
  const OBSERVED_AT = GO + 150;
  const CLICK_AT = 8300;
  const MONOTONIC_OFFSET = 700_000;
  const SEQUENCE = 7;

  const arming = client(ARM_START + 400, 0, MONOTONIC_OFFSET);
  const scheduled = pairScheduledGo({
    countdownEndsAt: SCHEDULED_GO,
    roundSequence: SEQUENCE,
    localNowMs: arming.perfNow(),
    deviceNowMs: arming.deviceNow(),
  });

  const reveal = client(OBSERVED_AT, 0, MONOTONIC_OFFSET);
  const anchor = resolveRoundAnchorLocal({
    scheduled,
    goInstant: GO,
    roundSequence: SEQUENCE,
    localNowMs: reveal.perfNow(),
    deviceNowMs: reveal.deviceNow(),
  });

  const click = client(CLICK_AT, 0, MONOTONIC_OFFSET);
  const displayed = elapsedSince(anchor, click.perfNow());
  const serverMeasured = CLICK_AT - GO; // what recordRoundStop will compute

  assert.equal(displayed, serverMeasured);
  assert.equal(serverMeasured, 2050);

  // The anchor the client used before this fix: start counting from the
  // reveal response. It reads low by the transport delay (150ms here), so a
  // stop that looked dead on a 2050ms target landed at 2200ms on the server.
  const oldDisplayed = elapsedSince(reveal.perfNow(), click.perfNow());
  assert.equal(oldDisplayed, serverMeasured - 150);
  assert.notEqual(oldDisplayed, serverMeasured);
});

test("a pairing from another round is never used", () => {
  // A tab that was throttled through a whole round can still hold a pairing
  // from the round before, whose scheduled GO is seconds away from the live
  // one. It has to be dropped (sequence, then the drift bound) and the reveal
  // used instead — the anchor is then the reveal's own, not the stale GO's.
  const OBSERVED_AT = 10_200;
  const GO = 10_050;
  const MONOTONIC_OFFSET = 700_000;
  const c = client(OBSERVED_AT, 0, MONOTONIC_OFFSET);
  // Stale pairing: last round's scheduled GO, 9s before this one.
  const stale = pairScheduledGo({
    countdownEndsAt: 6000,
    roundSequence: 2,
    localNowMs: c.perfNow() - 9000,
    deviceNowMs: c.deviceNow() - 9000,
  });

  const anchor = resolveRoundAnchorLocal({
    scheduled: stale,
    goInstant: GO,
    roundSequence: 5, // the live round is a different one
    localNowMs: c.perfNow(),
    deviceNowMs: c.deviceNow(),
  });

  // Same two checks the module makes, spelled out: the pairing is dropped and
  // the reveal response becomes the anchor.
  assert.ok(
    stale.roundSequence !== 5 &&
      GO - stale.serverMs > GO_DRIFT_TOLERANCE_MS,
  );
  assert.equal(anchor, c.perfNow() - (c.deviceNow() - GO));
  assert.equal(elapsedSince(anchor, c.perfNow()), OBSERVED_AT - GO);
});

test("an implausible drift falls back rather than anchoring on a bad pairing", () => {
  const OBSERVED_AT = 10_000;
  const MONOTONIC_OFFSET = 700_000;
  const c = client(OBSERVED_AT, 0, MONOTONIC_OFFSET);
  const scheduled = pairScheduledGo({
    countdownEndsAt: 6000,
    roundSequence: 9,
    localNowMs: c.perfNow() - 4000,
    deviceNowMs: c.deviceNow() - 4000,
  });

  // Way past the tolerance: too far after the scheduled end to be this
  // round's drift, so the pairing is dropped in favour of the reveal.
  const goInstant = 6000 + GO_DRIFT_TOLERANCE_MS + 1;
  const absurd = resolveRoundAnchorLocal({
    scheduled,
    goInstant,
    roundSequence: 9,
    localNowMs: c.perfNow(),
    deviceNowMs: c.deviceNow(),
  });
  assert.equal(elapsedSince(absurd, c.perfNow()), OBSERVED_AT - goInstant);

  // A GO stamped *before* the scheduled end cannot happen (the server only
  // reveals a due round) and is treated as unusable too.
  const before = resolveRoundAnchorLocal({
    scheduled,
    goInstant: 5999,
    roundSequence: 9,
    localNowMs: c.perfNow(),
    deviceNowMs: c.deviceNow(),
  });
  assert.equal(elapsedSince(before, c.perfNow()), OBSERVED_AT - 5999);
});

test("a client that never saw the round arm still shows the true elapsed", () => {
  // Fresh mount / reconnect mid-round: no scheduled stamp to pair against, so
  // the reveal response is all there is. The display resumes at the server's
  // elapsed instead of restarting from zero.
  const MONOTONIC_OFFSET = 700_000;
  const GO = 5000;
  const c = client(GO + 3400, 0, MONOTONIC_OFFSET);
  const anchor = resolveRoundAnchorLocal({
    scheduled: null,
    goInstant: GO,
    roundSequence: 11,
    localNowMs: c.perfNow(),
    deviceNowMs: c.deviceNow(),
  });
  assert.equal(elapsedSince(anchor, c.perfNow()), 3400);
});

test("with no GO yet the anchor falls back to the pairing, then to now", () => {
  const MONOTONIC_OFFSET = 700_000;
  const c = client(3000, 0, MONOTONIC_OFFSET);
  const scheduled = pairScheduledGo({
    countdownEndsAt: 6000,
    roundSequence: 12,
    localNowMs: c.perfNow(),
    deviceNowMs: c.deviceNow(),
  });

  const armed = resolveRoundAnchorLocal({
    scheduled,
    goInstant: null,
    roundSequence: 12,
    localNowMs: c.perfNow(),
    deviceNowMs: c.deviceNow(),
  });
  // 3s still to go -> the clock sits at zero until then.
  assert.equal(elapsedSince(armed, c.perfNow()), 0);

  const blank = resolveRoundAnchorLocal({
    scheduled: null,
    goInstant: null,
    roundSequence: null,
    localNowMs: c.perfNow(),
    deviceNowMs: c.deviceNow(),
  });
  assert.equal(elapsedSince(blank, c.perfNow()), 0);
});

test("the pairing assumes the device clock agrees with the server — exactly like the countdown", () => {
  // Honest limitation, pinned: the pairing is a server instant expressed in
  // the device's clock, so a device whose clock is off by S reads the timer S
  // off. The same device's 5-second countdown is off by the same S, so the
  // whole screen stays internally consistent — and this is the trade that
  // removes the (unwinnable, varying) poll lag from the display.
  const SCHEDULED_GO = 6000;
  const MONOTONIC_OFFSET = 700_000;
  const SKEW = 1500;
  const c = client(3000, SKEW, MONOTONIC_OFFSET);
  const pairing = pairScheduledGo({
    countdownEndsAt: SCHEDULED_GO,
    roundSequence: 13,
    localNowMs: c.perfNow(),
    deviceNowMs: c.deviceNow(),
  });
  const expectedPerfGo = SCHEDULED_GO - MONOTONIC_OFFSET;
  assert.equal(pairing.localMs, expectedPerfGo - SKEW);
});

test("elapsed never goes negative", () => {
  assert.equal(elapsedSince(1000, 999), 0);
  assert.equal(elapsedSince(1000, 1000), 0);
  assert.equal(elapsedSince(1000, 1001), 1);
});
