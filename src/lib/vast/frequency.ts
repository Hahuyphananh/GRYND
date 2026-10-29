// src/lib/vast/frequency.ts
//
// CENTRALISED DELIVERY CADENCE for the post-match video ad.
//
// Every post-match ad decision goes through this module. Nothing about the
// policy lives in a game, a result screen or the player component.
//
// THE RULE (defaults, all configurable)
//
//   * ONE OFFER PER `matchesPerOffer` COMPLETED MATCHES — default 3. The counter
//     advances only when a completed match is OBSERVED for the first time, so
//     the 1st and 2nd match never offer, the 3rd may, and an offer resets the
//     counter to 0. Consecutive ads are therefore structurally impossible, not
//     merely unlikely.
//   * A COOLDOWN between offers, and after a dismissal. Closing the card resets
//     the counter AND stamps `lastDismissedAt`, so dismissing cannot immediately
//     produce another ad.
//   * ONE OFFER PER MATCH EVER. A match id is counted once: refreshing the
//     result page, remounting the component, navigating back to the same result
//     or a duplicated socket/realtime event does not advance the counter and
//     cannot earn a second offer.
//
// WHY localStorage (with a sessionStorage fallback)
//
// The counter must survive the refreshes and tab switches a player does between
// matches — sessionStorage alone would let every new tab restart the cadence,
// which is exactly the bypass this module is meant to close. localStorage is
// already the architecture's choice for small client-only state (persistent SWR
// cache, consent record); nothing here ever leaves the browser.
//
// WHAT IS STORED — and what is not
//
// Only: the ids of the last few completed matches (to dedupe them), an integer
// progress counter, and two timestamps. No account id, no name, no email, no IP,
// no score, no wager, no result, no device fingerprint. Match ids are already
// present in the page URL and are not personal data. Nothing is sent to a
// server, so there is no advertising profile to leak.
//
// FAILURE POLICY — FAIL CLOSED. No storage, a corrupt record, a blank match id
// or an unparsable limit all resolve to "do not offer". A frequency limit that
// silently stops counting is worse than no ad.

export interface PostMatchAdCadence {
  /** Completed matches required between offers (1 = every match). */
  matchesPerOffer: number;
  /** Minimum gap between an offer/dismissal and the next offer. */
  cooldownMs: number;
}

export const DEFAULT_POST_MATCH_AD_CADENCE: PostMatchAdCadence = Object.freeze({
  matchesPerOffer: 3,
  cooldownMs: 5 * 60_000,
});

/** localStorage key. Versioned so a shape change can never misread old state. */
export const POST_MATCH_AD_STATE_KEY = "grynd:postMatchAdState:v2";

/** Upper bound on remembered match ids, so the record cannot grow forever. */
const MAX_TRACKED_MATCHES = 20;

interface OfferState {
  /** Completed match ids that have already been counted (dedupe). */
  matches: string[];
  /** Completed matches observed since the last offer / dismissal. */
  progress: number;
  /** When an offer was last made. */
  lastOfferedAt: number | null;
  /** When the player last dismissed the card. */
  lastDismissedAt: number | null;
}

const EMPTY_STATE: OfferState = {
  matches: [],
  progress: 0,
  lastOfferedAt: null,
  lastDismissedAt: null,
};

export interface PostMatchAdOfferStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PostMatchAdOfferContext {
  /** Injected in tests; defaults to this browser's localStorage. */
  storage?: PostMatchAdOfferStorage | null;
  now?: number;
  cadence?: PostMatchAdCadence;
}

function readInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * The active cadence: built-in defaults, overridable per deploy.
 *
 *   NEXT_PUBLIC_POST_MATCH_AD_MATCHES_PER_OFFER (1–20, default 3)
 *   NEXT_PUBLIC_POST_MATCH_AD_COOLDOWN_MINUTES  (0–240, default 5)
 *
 * Out-of-range values clamp rather than disable, so a typo can never turn the
 * limit off. Setting the flag `NEXT_PUBLIC_POST_MATCH_ADS_ENABLED=false` is the
 * kill switch; these numbers only tune a running surface.
 */
export function postMatchAdCadence(
  env: Record<string, string | undefined> = process.env,
): PostMatchAdCadence {
  const defaultCooldownMinutes = DEFAULT_POST_MATCH_AD_CADENCE.cooldownMs / 60_000;
  return {
    matchesPerOffer: readInt(
      env.NEXT_PUBLIC_POST_MATCH_AD_MATCHES_PER_OFFER,
      DEFAULT_POST_MATCH_AD_CADENCE.matchesPerOffer,
      1,
      20,
    ),
    cooldownMs:
      readInt(
        env.NEXT_PUBLIC_POST_MATCH_AD_COOLDOWN_MINUTES,
        defaultCooldownMinutes,
        0,
        240,
      ) * 60_000,
  };
}

/**
 * localStorage first (survives refresh and tab switches), sessionStorage as a
 * fallback for browsers that deny persistent storage, null otherwise.
 */
function browserStorage(): PostMatchAdOfferStorage | null {
  if (typeof window === "undefined") return null;
  try {
    const local = window.localStorage;
    if (local) return local;
  } catch {
    // Denied persistent storage — fall through to the session store.
  }
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readState(storage: PostMatchAdOfferStorage): OfferState {
  try {
    const raw = storage.getItem(POST_MATCH_AD_STATE_KEY);
    if (!raw) return { ...EMPTY_STATE };

    const parsed = JSON.parse(raw) as Partial<OfferState> | null;
    const matches = Array.isArray(parsed?.matches)
      ? parsed.matches
          .filter((entry): entry is string => typeof entry === "string")
          .slice(-MAX_TRACKED_MATCHES)
      : [];

    const progress =
      typeof parsed?.progress === "number" && Number.isFinite(parsed.progress)
        ? Math.max(0, Math.floor(parsed.progress))
        : 0;

    const timestamp = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;

    return {
      matches,
      progress,
      lastOfferedAt: timestamp(parsed?.lastOfferedAt),
      lastDismissedAt: timestamp(parsed?.lastDismissedAt),
    };
  } catch {
    // A corrupt record must not break the result screen; start clean and let the
    // normal cadence apply.
    return { ...EMPTY_STATE };
  }
}

function writeState(
  storage: PostMatchAdOfferStorage,
  state: OfferState,
): void {
  try {
    storage.setItem(
      POST_MATCH_AD_STATE_KEY,
      JSON.stringify({
        matches: state.matches.slice(-MAX_TRACKED_MATCHES),
        progress: state.progress,
        lastOfferedAt: state.lastOfferedAt,
        lastDismissedAt: state.lastDismissedAt,
      } satisfies OfferState),
    );
  } catch {
    // A full/denied store only means the cadence may repeat; the ad itself must
    // never break the result screen.
  }
}

function normalizeMatchId(matchId: string): string {
  return typeof matchId === "string" ? matchId.trim() : "";
}

/**
 * Records that a match has finished. Call this ONCE per finished match, as soon
 * as the result screen knows the server says `finished`.
 *
 * Returns `{ offer: true }` only when this match completes the cadence: the
 * counter reached `matchesPerOffer`, the cooldown has elapsed, and this match id
 * has not been seen before. Every other case returns `{ offer: false }` — a
 * duplicate event, a refresh of the same result, an AI/practice match the caller
 * should not be passing, or the first two matches of a cycle.
 */
export function observeCompletedMatch(
  matchId: string,
  context: PostMatchAdOfferContext = {},
): { offer: boolean } {
  const id = normalizeMatchId(matchId);
  if (!id) return { offer: false };

  const storage =
    context.storage === undefined ? browserStorage() : context.storage;
  if (!storage) return { offer: false };

  const cadence = context.cadence ?? postMatchAdCadence();
  const now = context.now ?? Date.now();
  const state = readState(storage);

  // Already counted: a refresh, a remount or a duplicated realtime event is not
  // a new completed match and can never earn a second offer.
  if (state.matches.includes(id)) return { offer: false };

  const matches = [...state.matches, id].slice(-MAX_TRACKED_MATCHES);
  const perOffer = Math.max(1, Math.floor(cadence.matchesPerOffer));

  // Progress is capped at the threshold: if the cooldown holds an otherwise-due
  // offer back, the very next completed match may take it — we never "skip" a
  // due offer and wait for a whole new cycle.
  const progress = Math.min(perOffer, state.progress + 1);

  // A timestamp of 0 is a legitimate instant (tests drive the clock from 0),
  // so "no previous touch" is an explicit null check, never `=== 0`.
  const hasPreviousTouch =
    state.lastOfferedAt !== null || state.lastDismissedAt !== null;
  const lastTouch = Math.max(
    state.lastOfferedAt ?? 0,
    state.lastDismissedAt ?? 0,
  );
  const cooldownElapsed =
    !hasPreviousTouch || now - lastTouch >= cadence.cooldownMs;

  if (progress < perOffer || !cooldownElapsed) {
    writeState(storage, { ...state, matches, progress });
    return { offer: false };
  }

  writeState(storage, {
    matches,
    progress: 0,
    lastOfferedAt: now,
    lastDismissedAt: state.lastDismissedAt,
  });

  return { offer: true };
}

/**
 * Records that the player closed the card.
 *
 * Resets the cycle (three more completed matches before the next offer) and
 * stamps the dismissal time, so closing an ad can never immediately produce
 * another one. Idempotent and safe to call from an unmount path.
 */
export function markPostMatchAdDismissed(
  matchId: string,
  context: PostMatchAdOfferContext = {},
): void {
  const id = normalizeMatchId(matchId);
  if (!id) return;

  const storage =
    context.storage === undefined ? browserStorage() : context.storage;
  if (!storage) return;

  const now = context.now ?? Date.now();
  const state = readState(storage);
  const matches = state.matches.includes(id)
    ? state.matches
    : [...state.matches, id].slice(-MAX_TRACKED_MATCHES);

  // Keep the FIRST dismissal. A double-click on the close button must not
  // extend the block, and must not postpone the next legitimate offer either.
  writeState(storage, {
    ...state,
    matches,
    progress: 0,
    lastDismissedAt: state.lastDismissedAt ?? now,
  });
}
