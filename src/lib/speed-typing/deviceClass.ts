// src/lib/speed-typing/deviceClass.ts
//
// WHICH INPUT DEVICE A SEAT IS RACING ON — and the only two things the rest of
// the game needs from that answer: whether two seats belong in the same pool,
// and which open lobby a caller should be handed.
//
// WHY THE CLASS EXISTS. The race is identical for both seats: same passage,
// same absolute GO instant, same server clock. The only thing that is not
// identical is the input method, and a touch keyboard is structurally slower
// than a physical one — so a phone-vs-computer race measures hardware rather
// than typing skill. `createOrJoin` therefore prefers to pair within a pool
// (see `pickLobbyFor`), with a widening window so nobody in a quiet pool waits
// forever (DEVICE_MATCH_WIDEN_MS, ../constants.ts).
//
// WHERE THE CLASS COMES FROM. The REQUEST'S OWN HEADERS — never a field a
// player sends. `Sec-CH-UA-Mobile`, then `Sec-CH-UA-Platform`, then the
// User-Agent. That is not a stylistic choice: the create-or-join route's
// contract is that a client may only ever say WHAT IT TYPED, a contract pinned
// by tests/speed-typing-e2e.test.mjs and tests/speed-typing-platform.test.mjs
// (both assert the route reads no body and no search params). A self-declared
// device class would be exactly the kind of client claim the rest of this game
// refuses, and a trivially forgeable one at that.
//
// WHAT IT CANNOT SEE. A client that lies about its User-Agent can land itself
// in the touch pool; a plain browser cannot change these headers, and a
// browser that is honestly a phone is always classified as one. iPadOS Safari
// reports a `Macintosh` User-Agent (it has no `Sec-CH-UA-Mobile` either), so an
// iPad with a physical keyboard may be pooled as a computer — the conservative
// direction, since it can still type.
//
// Pure and dependency-free (no `node:` imports) so the store, the route and the
// tests can all read one implementation.

import {
  DEVICE_CLASS,
  DEVICE_MATCH_WIDEN_MS,
  UNKNOWN_DEVICE_CLASS,
  type DevicePool,
} from "./constants";

/** Just the header surface these functions need — a `Headers` also satisfies it. */
export type HeaderReader = { get(name: string): string | null };

/**
 * The header value, trimmed, or null when absent/blank. Missing headers are
 * common (iOS Safari sends no client hints at all), so "no value" is a normal
 * answer and never an error.
 */
function headerValue(headers: HeaderReader | null | undefined, name: string): string | null {
  const raw = headers?.get?.(name);
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length ? value : null;
}

/**
 * A phone or tablet by User-Agent.
 *
 * Checked BEFORE the desktop patterns below, because a mobile UA contains both
 * (`Mozilla/5.0 (iPhone; …) … Safari/537.36`). `Mobile` alone covers the
 * overwhelming majority; the explicit names are there for browsers in desktop
 * mode (Android tablets, iPad, and the older mobile platforms) which still
 * advertise their hardware even when they claim a desktop layout.
 */
const TOUCH_UA = /iPhone|iPod|iPad|Tablet|Android|Windows Phone|IEMobile|BlackBerry|Opera Mini|\bMobi\b|\bMobile\b/i;

/** A real browser that is not a phone: a computer, with a keyboard. */
const DESKTOP_UA = /Mozilla|AppleWebKit|Gecko|Chrome|Chromium|Safari|Firefox|Edg\/|OPR\//i;

/**
 * `Sec-CH-UA-Platform` values that mean "no physical keyboard".
 *
 * Chrome OS is NOT here: the platform almost always means a Chromebook, which
 * has one — and the browser itself answers `Sec-CH-UA-Mobile: ?1` on a Chrome OS
 * tablet, which is checked first.
 */
const TOUCH_PLATFORM = /Android|iOS/i;

/** `Sec-CH-UA-Platform` values that mean "a computer". */
const DESKTOP_PLATFORM = /Windows|macOS|Linux|Chrome OS/i;

/**
 * The input pool a request's headers describe.
 *
 * The order of the three signals is the order of their trustworthiness:
 *   1. `Sec-CH-UA-Mobile` — Chromium answers `?1` for a phone/tablet and `?0`
 *      for a computer, and it is what that browser thinks the device IS rather
 *      than a guess from a string format. Decisive when present.
 *   2. `Sec-CH-UA-Platform` — decides the same question by platform name when
 *      the mobile hint was stripped (a proxy, a Safari-like UA).
 *   3. The User-Agent — the fallback for everything else. A request with no
 *      usable UA at all (a bot, a bare HTTP call) is `unknown`, and an unknown
 *      seat pairs with anyone.
 */
export function deviceClassFromHeaders(
  headers: HeaderReader | null | undefined,
): DevicePool {
  // 1. Client hint: the browser's own answer.
  const mobile = headerValue(headers, "sec-ch-ua-mobile");
  if (mobile === "?1") return DEVICE_CLASS.TOUCH;
  if (mobile === "?0") return DEVICE_CLASS.KEYBOARD;

  // 2. Client hint: the platform name.
  const platform = headerValue(headers, "sec-ch-ua-platform");
  if (platform) {
    const name = platform.replace(/^"|"$/g, "");
    if (TOUCH_PLATFORM.test(name)) return DEVICE_CLASS.TOUCH;
    if (DESKTOP_PLATFORM.test(name)) return DEVICE_CLASS.KEYBOARD;
  }

  // 3. The User-Agent string.
  const ua = headerValue(headers, "user-agent");
  if (!ua) return UNKNOWN_DEVICE_CLASS;
  if (TOUCH_UA.test(ua)) return DEVICE_CLASS.TOUCH;
  if (DESKTOP_UA.test(ua)) return DEVICE_CLASS.KEYBOARD;
  return UNKNOWN_DEVICE_CLASS;
}

/**
 * The pool a stored value names. Anything unrecognised (null, a legacy row, a
 * value written before this feature) resolves to `unknown`, which is
 * class-neutral — the shared `coerce*` convention every other Speed Typing
 * vocabulary follows (see `coerceAiDifficulty`).
 */
export function coerceDeviceClass(value: unknown): DevicePool {
  if (value === DEVICE_CLASS.KEYBOARD) return DEVICE_CLASS.KEYBOARD;
  if (value === DEVICE_CLASS.TOUCH) return DEVICE_CLASS.TOUCH;
  return UNKNOWN_DEVICE_CLASS;
}

/**
 * The value to WRITE to a `*_device_class` column for a pool.
 *
 * `unknown` is stored as NULL, never as the string: the column's CHECK
 * constraint (migration 0209) admits only the two real pool names or NULL, so
 * an unclassifiable seat is absent from the vocabulary rather than a third
 * value in it.
 */
export function deviceClassColumnValue(pool: unknown): string | null {
  const coerced = coerceDeviceClass(pool);
  return coerced === UNKNOWN_DEVICE_CLASS ? null : coerced;
}

/** The shape matchmaking needs from an open lobby row. */
export type LobbyCandidate = {
  id: string;
  player1Id: string;
  player1DeviceClass?: unknown;
  createdAt?: Date | string | number | null;
};

/**
 * The instant a lobby was created, or `null` when it carries no usable date.
 *
 * `null` rather than a sentinel instant: a missing (or unparseable) date is an
 * UNKNOWN wait, not an infinitely long one, so a row without one can never
 * qualify for widening by accident.
 */
function queuedAtMs(candidate: LobbyCandidate): number | null {
  const value = candidate.createdAt;
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The open lobby a caller should be handed, or null to open a new one.
 *
 * `candidates` must be the open lobbies, OLDEST FIRST. The rules, in order:
 *
 *   1. An unclassifiable caller keeps the pre-0209 behaviour exactly: the
 *      oldest open lobby, whatever pool it is in. That is what the platform
 *      quick-queue's two calls do (they carry no device signal), so the queue
 *      path is untouched by this feature.
 *   2. The oldest lobby in the caller's OWN pool. This is the fairness win.
 *   3. The oldest class-NEUTRAL lobby (no device class: a legacy row or a
 *      quick-queue placeholder). Neutral means "pairs with anyone", which is
 *      why it is checked before the widening rule and without a wait.
 *   4. The oldest lobby in the OTHER pool, but only once it has been waiting
 *      at least `widenMs`. A lobby that has waited that long has already paid
 *      more in queue time than a mixed-input race costs it.
 *   5. Otherwise null: the caller opens their own lobby in their own pool,
 *      rather than being dropped into an unfair race the instant they arrive.
 *
 * Pure, so the store's whole matchmaking decision is testable without a
 * database.
 */
export function pickLobbyFor<T extends LobbyCandidate>({
  candidates,
  deviceClass,
  nowMs,
  widenMs = DEVICE_MATCH_WIDEN_MS,
}: {
  candidates: readonly T[];
  deviceClass: unknown;
  nowMs: number;
  widenMs?: number;
}): T | null {
  if (!candidates.length) return null;

  const caller = coerceDeviceClass(deviceClass);

  // 1. No class to pool by — behave exactly as before this feature existed.
  if (caller === UNKNOWN_DEVICE_CLASS) return candidates[0];

  const poolOf = (candidate: T) => coerceDeviceClass(candidate.player1DeviceClass);

  // 2. Same pool.
  const samePool = candidates.find((candidate) => poolOf(candidate) === caller);
  if (samePool) return samePool;

  // 3. Class-neutral.
  const neutral = candidates.find((candidate) => poolOf(candidate) === UNKNOWN_DEVICE_CLASS);
  if (neutral) return neutral;

  // 4. The other pool, once the wait has earned it. A lobby whose age cannot
  //    be read never proves it has waited.
  const widened = candidates.find((candidate) => {
    const queuedAt = queuedAtMs(candidate);
    return queuedAt != null && nowMs - queuedAt >= widenMs;
  });
  if (widened) return widened;

  // 5. Open a new lobby in the caller's own pool.
  return null;
}
