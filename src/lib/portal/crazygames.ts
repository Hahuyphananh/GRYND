// src/lib/portal/crazygames.ts
//
// The CrazyGames SDK v3 bridge, kept pure so it can be tested without a browser
// or the real SDK.
//
// ── THE RULES THE SDK ASKS FOR ────────────────────────────────────────────
//
//   · `init()` once, before any other call.
//   · `gameplayStart()` when the player actually starts playing (their first
//     input), `gameplayStop()` when play stops — a result screen, a pause, a
//     hidden tab. The pair is what their runtime measures play time with; a
//     "started" that is never stopped inflates the session and a "stopped" that
//     is never restarted kills the session.
//   · Ads only through the SDK, only between sessions of play — never during
//     gameplay, and never back-to-back.
//
// ── NO SDK, NO PROBLEM ────────────────────────────────────────────────────
//
// The app runs normally on grynd, in an itch.io frame, and in a plain browser.
// In all of those `window.CrazyGames` is absent, and every method here returns
// quietly. That is the contract the component relies on: nothing has to be
// guarded at the call site.
//
// ── THE REASON THIS IS A MODULE AND NOT A HOOK ────────────────────────────
//
// The interesting decisions (is this a CrazyGames visit? may an ad run now?) are
// pure and worth testing; the browser parts (script tag, event listeners) live
// in components/portal/PortalSdkBridge.tsx.

/** The v3 bundle CrazyGames serves to iframed games. */
export const CRAZYGAMES_SDK_SRC = "https://sdk.crazygames.com/crazygames-sdk-v3.js";

/** How long a completed ad has to be followed by gameplay before another may run. */
export const AD_COOLDOWN_MS = 60_000;

/** Query value that marks an exported visit (`?portal=crazygames`). */
export const CRAZYGAMES_PORTAL_PARAM = "crazygames";

/**
 * The DOM event a game dispatches when a match has finished.
 *
 * It is deliberately a DOM event rather than a prop or a context: the games are
 * four separate screens that must not learn about portals, and the bridge only
 * exists on the portal surface. Nothing listens outside a portal visit, so the
 * dispatch is inert everywhere else.
 */
export const PORTAL_MATCH_FINISHED_EVENT = "grynd:portal-match-finished";

/** A visit counts as a CrazyGames visit when the URL says so or the referrer is theirs. */
export function isCrazyGamesContext(input: {
  portal?: string | null;
  referrer?: string | null;
}): boolean {
  if (typeof input.portal === "string" && input.portal.toLowerCase() === CRAZYGAMES_PORTAL_PARAM) {
    return true;
  }
  const referrer = input.referrer;
  if (typeof referrer !== "string" || !referrer) return false;
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    return host === "crazygames.com" || host.endsWith(".crazygames.com");
  } catch {
    return false;
  }
}

/** The slice of the SDK this bridge uses. Anything missing is simply not called. */
export type CrazyGamesSdk = {
  init?: () => Promise<void> | void;
  gameplayStart?: () => void;
  gameplayStop?: () => void;
  ad?: { requestAd?: (type: string) => Promise<void> | void };
};

export type AdKind = "midgame" | "rewarded";

export type CrazyGamesBridgeState = {
  initialised: boolean;
  playing: boolean;
  inAd: boolean;
  lastAdAt: number | null;
  adsRequested: number;
};

export type CrazyGamesBridge = {
  init: () => Promise<boolean>;
  gameplayStart: () => void;
  gameplayStop: () => void;
  /** Request an ad if the rules allow it right now. Resolves true when one ran. */
  requestAd: (kind?: AdKind) => Promise<boolean>;
  state: () => CrazyGamesBridgeState;
};

/**
 * Build the bridge over an SDK (or `undefined` when the SDK never loaded).
 *
 * Every SDK call is wrapped: a throwing or half-implemented SDK degrades to a
 * no-op rather than breaking the game. `gameplayStart` while an ad is running is
 * deferred until the ad ends, so the SDK never sees overlapping states.
 */
export function createCrazyGamesBridge(
  sdk: CrazyGamesSdk | null | undefined,
  now: () => number = () => Date.now(),
): CrazyGamesBridge {
  const state: CrazyGamesBridgeState = {
    initialised: false,
    playing: false,
    inAd: false,
    lastAdAt: null,
    adsRequested: 0,
  };

  const call = (fn: (() => void) | undefined) => {
    if (typeof fn !== "function") return;
    try {
      fn();
    } catch {
      // A broken SDK must never break a match.
    }
  };

  const init = async (): Promise<boolean> => {
    if (!sdk) return false;
    if (state.initialised) return true;
    if (typeof sdk.init !== "function") return false;
    try {
      await sdk.init();
      state.initialised = true;
      return true;
    } catch {
      return false;
    }
  };

  const gameplayStart = () => {
    if (!sdk || state.playing || state.inAd) return;
    state.playing = true;
    call(sdk.gameplayStart);
  };

  const gameplayStop = () => {
    if (!sdk || !state.playing) return;
    state.playing = false;
    call(sdk.gameplayStop);
  };

  const requestAd = async (kind: AdKind = "midgame"): Promise<boolean> => {
    if (!sdk || !sdk.ad || typeof sdk.ad.requestAd !== "function") return false;
    // Never over live gameplay: the SDK requires a stopped session, and the
    // player must never lose a turn to a video.
    if (state.playing || state.inAd) return false;
    // Never back-to-back.
    if (state.lastAdAt !== null && now() - state.lastAdAt < AD_COOLDOWN_MS) return false;
    // Only the two kinds CrazyGames documents.
    if (kind !== "midgame" && kind !== "rewarded") return false;

    state.inAd = true;
    try {
      await sdk.ad.requestAd(kind);
      state.lastAdAt = now();
      state.adsRequested += 1;
      return true;
    } catch {
      return false;
    } finally {
      state.inAd = false;
    }
  };

  return {
    init,
    gameplayStart,
    gameplayStop,
    requestAd,
    state: () => ({ ...state }),
  };
}

/**
 * A bridge for the common "no SDK loaded" case, sharing one implementation so
 * call sites never branch.
 */
export const NOOP_CRAZYGAMES_BRIDGE: CrazyGamesBridge = createCrazyGamesBridge(undefined);
