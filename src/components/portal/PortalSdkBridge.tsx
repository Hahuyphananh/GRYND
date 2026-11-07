"use client";

// src/components/portal/PortalSdkBridge.tsx
//
// Mounts the CrazyGames SDK v3 bridge on the portal surface (`/play/<gameKey>`)
// when — and only when — the page is actually running inside CrazyGames.
//
// All the judgement lives in the pure module:
//
//   lib/portal/crazygames.ts  — is this a portal visit? may an ad run now?
//   (this file)               — the script tag, the listeners, the lifecycle.
//
// ── WHAT IT DOES ──────────────────────────────────────────────────────────
//
//   · loads https://sdk.crazygames.com/crazygames-sdk-v3.js, once;
//   · `init()`s it, and waits for that before anything else;
//   · `gameplayStart()` on the player's FIRST input — the SDK wants "the player
//     is actually playing", not "the page loaded";
//   · `gameplayStop()` when a match finishes (the games announce it on
//     PORTAL_MATCH_FINISHED_EVENT), when the tab is hidden, and on pagehide;
//   · requests one midgame ad at the first allowed moment after play stops.
//
// ── WHAT IT CANNOT DO ─────────────────────────────────────────────────────
//
// Break the game. The SDK may be absent, blocked, slow, half-implemented or
// throw; every path degrades to a no-op, the script tag has no timeout, and
// nothing here is on the critical path of a move. A portal visit with a broken
// SDK plays exactly like a normal visit — it just does not report play time.
//
// ── WHY THE PARENT FRAME IS NOT INVOLVED ──────────────────────────────────
//
// CrazyGames passes the SDK into the iframe; there is no postMessage handshake
// for us to implement or spoof. We therefore never trust the referrer alone:
// `isCrazyGamesContext` needs `?portal=crazygames` or a crazygames.com referrer,
// and even then the SDK only exists because their parent page provided it. If
// neither is true this component renders nothing and loads nothing.

import { useEffect } from "react";

import {
  CRAZYGAMES_SDK_SRC,
  PORTAL_MATCH_FINISHED_EVENT,
  createCrazyGamesBridge,
  isCrazyGamesContext,
  type CrazyGamesSdk,
} from "../../lib/portal/crazygames";

declare global {
  interface Window {
    CrazyGames?: { SDK?: CrazyGamesSdk };
  }
}

const SCRIPT_MARKER = "data-grynd-portal-sdk";
const SDK_READY_TIMEOUT_MS = 8000;

/** Load the SDK bundle once; resolve either way — failure is not an error here. */
function loadSdkScript(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  if (window.CrazyGames?.SDK) return Promise.resolve();

  return new Promise((resolve) => {
    const existing = document.querySelector(`script[${SCRIPT_MARKER}]`);
    const schedule = (node: Element | null) => {
      if (!node) return resolve();
      node.addEventListener("load", () => resolve(), { once: true });
      node.addEventListener("error", () => resolve(), { once: true });
      // A script that neither loads nor errors (a blocked CDN) must not hang
      // the lifecycle forever.
      window.setTimeout(resolve, SDK_READY_TIMEOUT_MS);
    };

    if (existing) {
      schedule(existing);
      return;
    }

    const script = document.createElement("script");
    script.src = CRAZYGAMES_SDK_SRC;
    script.async = true;
    script.setAttribute(SCRIPT_MARKER, "1");
    schedule(script);
    document.head.appendChild(script);
  });
}

export default function PortalSdkBridge({ portal }: { portal?: string | null }) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isCrazyGamesContext({ portal, referrer: document.referrer })) return;

    let disposed = false;
    let detach = () => {};

    // Reassigned once the SDK is present; every listener reads the current one.
    let bridge = createCrazyGamesBridge(undefined);

    const onFirstInput = () => {
      bridge.gameplayStart();
    };
    const onMatchFinished = () => {
      bridge.gameplayStop();
      // Only after a finished match, and only if the cooldown allows it: the
      // player has just stopped playing, which is the one honest ad moment.
      void bridge.requestAd("midgame");
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") bridge.gameplayStop();
      else if (document.visibilityState === "visible") bridge.gameplayStart();
    };
    const onPageHide = () => bridge.gameplayStop();

    const attach = () => {
      window.addEventListener("pointerdown", onFirstInput, { passive: true });
      window.addEventListener("keydown", onFirstInput);
      window.addEventListener(PORTAL_MATCH_FINISHED_EVENT, onMatchFinished);
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("pagehide", onPageHide);
      detach = () => {
        window.removeEventListener("pointerdown", onFirstInput);
        window.removeEventListener("keydown", onFirstInput);
        window.removeEventListener(PORTAL_MATCH_FINISHED_EVENT, onMatchFinished);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("pagehide", onPageHide);
      };
    };

    void (async () => {
      await loadSdkScript();
      if (disposed) return;
      const sdk = window.CrazyGames?.SDK;
      if (!sdk) return; // no SDK: nothing to report to. Play on.
      bridge = createCrazyGamesBridge(sdk);
      const ready = await bridge.init();
      if (!ready || disposed) return;
      attach();
    })();

    return () => {
      disposed = true;
      bridge.gameplayStop();
      detach();
    };
  }, [portal]);

  return null;
}
