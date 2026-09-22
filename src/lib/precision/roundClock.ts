// ── The running-timer display clock for a Precision round ────────────────
//
// The match page shows the player a live "elapsed" counter that they time
// their STOP against. The number that DECIDES the round is the server's:
// `recordRoundStop` measures `Date.now() - roundGoInstant`. So the display
// has to count from that same instant — not from the moment this client
// happened to notice the round had opened. Anchoring on the observation made
// the display read LOW by one poll interval plus a round trip (up to ~250 ms),
// so a stop that looked dead on the target landed late on the server.
//
// Two server stamps make the right anchor reachable:
//
//   * `countdownEndsAt` — the SCHEDULED GO, delivered while the round arms,
//     i.e. before the round opens;
//   * `roundGoInstant`  — the ACTUAL GO, stamped when some reader revealed
//     the round. It can land a little after the scheduled end, because a
//     round opens on the first read past its countdown.
//
// Expressing a server instant in the local clock takes exactly one response:
// the offset `serverStamp - deviceNow` read from the SAME response is that
// instant in the device's own clock, so the request/response latency and the
// device's clock skew both drop out of the pairing. Pairing the scheduled GO
// that way gives "when the round was supposed to open", in local time. The
// reveal then contributes `roundGoInstant - countdownEndsAt` — the drift
// between the scheduled and the actual GO, a difference of two SERVER stamps,
// so it is exact. The sum is the local time of the instant the server scores
// from, with neither the poll delay nor the clock skew in it.
//
// A pairing is only trusted for the round it came from (`roundSequence`) and
// only when the drift is plausible, so a stale pairing can never be applied
// to a later round.
//
// Fallback: a client that never saw the round arm (fresh mount, reconnect
// mid-round) can only anchor on the reveal itself, which is late by one
// response — the previous behaviour, and the best available without a
// scheduled stamp to pair against.

/** The scheduled GO of one round, expressed in both clocks. */
export type ScheduledGoPairing = {
  /** The server's scheduled GO instant (`countdownEndsAt`) in the SERVER clock. */
  serverMs: number;
  /** The same instant in the LOCAL monotonic clock (`performance.now()` basis). */
  localMs: number;
  /** The round envelope this pairing belongs to. */
  roundSequence: number;
};

/**
 * The largest believable gap between the scheduled GO and the stamped one.
 * Revealing a round costs one read, so the drift is one request at most (a
 * few hundred ms); anything beyond this means the pairing is not this
 * round's and must not be used.
 */
export const GO_DRIFT_TOLERANCE_MS = 2_000;

/**
 * Pair the server's scheduled GO instant with the local clock. `localNowMs`
 * and `deviceNowMs` MUST be sampled at the same moment (adjacent statements):
 * the pairing is a difference between two clocks read in the same tick, which
 * is what makes the network delay cancel out of it.
 */
/**
 * Estimate `deviceWallClock - serverWallClock` from ONE request/response pair.
 *
 * The display has to count from a SERVER instant, and the only local clock that
 * can bridge to it is the device's wall clock — which is regularly skewed by
 * seconds (a stale NTP, a suspended phone, a VM). Bridging through a skewed
 * device clock shifts the whole display by that skew, so a player can stop dead
 * on the number they are looking at and still be graded seconds away from the
 * target: their stop "never happened".
 *
 * A response that carries the server's own `now` fixes it. This is the classic
 * NTP estimate — half the round trip is attributed to each direction — so the
 * residual error is the RTT ASYMMETRY (a few ms on a normal connection) rather
 * than the device's skew (seconds).
 *
 * Returns null when any input is unusable (no `now` on the response, a clock
 * that jumped, etc.), which leaves the caller on the uncorrected clock.
 */
export function estimateServerClockOffset(params: {
  /** `Date.now()` taken immediately before the request was sent. */
  sentAtDeviceMs: number;
  /** `Date.now()` taken the moment the response was parsed. */
  receivedAtDeviceMs: number;
  /** The server's `Date.now()`, stamped when it built the response. */
  serverNowMs: number;
}): number | null {
  const { sentAtDeviceMs, receivedAtDeviceMs, serverNowMs } = params;
  if (
    !Number.isFinite(sentAtDeviceMs) ||
    !Number.isFinite(receivedAtDeviceMs) ||
    !Number.isFinite(serverNowMs)
  ) {
    return null;
  }
  const rttMs = Math.max(0, receivedAtDeviceMs - sentAtDeviceMs);
  return receivedAtDeviceMs - serverNowMs - rttMs / 2;
}

/**
 * The device's wall clock expressed in the SERVER's frame, i.e. what the
 * server would read right now. Every pairing below is fed this instead of raw
 * `Date.now()`, which is what takes the device's skew (and therefore the
 * seconds-wide gap between what the player stopped at and what the server
 * measures) out of the display.
 */
export function serverClockNow(deviceNowMs: number, offsetMs: number): number {
  const offset = Number.isFinite(offsetMs) ? offsetMs : 0;
  return deviceNowMs - offset;
}

export function pairScheduledGo(params: {
  /** Server-stamped `countdownEndsAt`. */
  countdownEndsAt: number;
  /** The round envelope carrying that stamp. */
  roundSequence: number;
  /** `performance.now()` — monotonic, the clock the display counts in. */
  localNowMs: number;
  /** `Date.now()` — the wall clock, the basis the server stamp is paired with. */
  deviceNowMs: number;
}): ScheduledGoPairing {
  const { countdownEndsAt, roundSequence, localNowMs, deviceNowMs } = params;
  return {
    serverMs: countdownEndsAt,
    localMs: localNowMs + (countdownEndsAt - deviceNowMs),
    roundSequence,
  };
}

/**
 * The local instant the round's display clock starts from — the server's GO,
 * expressed in the local monotonic clock.
 *
 * Uses the scheduled pairing plus the reveal's server-side drift whenever the
 * pairing belongs to this round and the drift is plausible; otherwise anchors
 * on the reveal response (late by one round trip, but never wrong in
 * direction) or on the pairing alone if the server has not stamped a GO yet.
 */
export function resolveRoundAnchorLocal(params: {
  scheduled: ScheduledGoPairing | null;
  /** Server-stamped `roundGoInstant`, or null before the reveal. */
  goInstant: number | null;
  /** The round envelope currently on the public state. */
  roundSequence: number | null;
  /** `performance.now()` and `Date.now()`, sampled at the same moment. */
  localNowMs: number;
  deviceNowMs: number;
}): number {
  const { scheduled, goInstant, roundSequence, localNowMs, deviceNowMs } = params;

  if (typeof goInstant === "number" && Number.isFinite(goInstant)) {
    if (
      scheduled &&
      scheduled.roundSequence === roundSequence &&
      goInstant >= scheduled.serverMs &&
      goInstant - scheduled.serverMs <= GO_DRIFT_TOLERANCE_MS
    ) {
      return scheduled.localMs + (goInstant - scheduled.serverMs);
    }
    // No usable pairing: the reveal is the only clock we have. `deviceNowMs -
    // goInstant` is how long the server's round has been open, so the display
    // resumes at the true elapsed rather than restarting from 0.
    return localNowMs - (deviceNowMs - goInstant);
  }

  if (scheduled) return scheduled.localMs;
  return localNowMs;
}

/** Elapsed time on the display clock. Never negative. */
export function elapsedSince(anchorLocalMs: number, localNowMs: number): number {
  return Math.max(0, localNowMs - anchorLocalMs);
}
