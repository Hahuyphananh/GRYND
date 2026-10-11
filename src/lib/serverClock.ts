// ── Expressing a server instant in the device's clock ────────────────────
//
// A clocked match stores its pacing as an absolute instant the SERVER stamped,
// and the client has to reason about that instant in its own clock: to count a
// displayed countdown down to zero, and to arm one read at the instant the
// server will advance the match on.
//
// The obvious bridge — "the server said 12:00:10, my clock says 12:00:07, so I
// wait 3 seconds" — is only correct if the two clocks agree, and they routinely
// do not: a stale NTP, a suspended phone or a VM can be seconds off. Bridging
// through a skewed device clock shifts everything by that skew, so a countdown
// runs out when the server still has seconds left (or `useDeadlineRead` fires
// its read before the store will accept the advance and pays a retry).
//
// One response carrying the server's own clock fixes it. `sentAt` and
// `receivedAt` bracket the request, so half the round trip is attributed to
// each direction and the residual error is the RTT's ASYMMETRY (a few ms on a
// normal connection) rather than the device's skew (seconds). This is the same
// estimate the Precision round clock has always used; it lives here so every
// clocked game shares one implementation.

/**
 * Estimate `deviceWallClock - serverWallClock` from ONE request/response pair.
 *
 * Returns null when any input is unusable (no server clock on the response, a
 * clock that jumped, a NaN timestamp), which leaves the caller on the
 * uncorrected clock — the caller must treat null as "no estimate", never as
 * "offset 0".
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
    !Number.isFinite(serverNowMs) ||
    serverNowMs <= 0
  ) {
    return null;
  }
  const rttMs = Math.max(0, receivedAtDeviceMs - sentAtDeviceMs);
  return receivedAtDeviceMs - serverNowMs - rttMs / 2;
}

/**
 * The device's wall clock expressed in the SERVER's frame — what the server
 * would read right now, as far as this device can tell.
 */
export function serverClockNow(deviceNowMs: number, offsetMs: number): number {
  const offset = Number.isFinite(offsetMs) ? offsetMs : 0;
  return deviceNowMs - offset;
}

/** Where the clock sample comes from. Kept next to the maths so the endpoint
 *  and the estimator can never drift apart. */
export const SERVER_TIME_PATH = "/api/server-time";
