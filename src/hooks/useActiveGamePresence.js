"use client";

// src/hooks/useActiveGamePresence.js
//
// The ONE client integration point for the casino lobby's "N playing" badge.
// It drives the Phase 2 backend (POST /api/presence/active-game) from the
// lifecycle signal a game surface ALREADY has, so no game needed its own
// presence implementation:
//
//   useActiveGamePresence(gameLabel, active, { enabled, terminal })
//
//   gameLabel  the label the page already passes to <GameSessionHost
//              gameLabel> / useRecordPlayedGame ("mines-duel", "chess-ai", …).
//              Resolved server-side (src/lib/gamePresence.js); a label that
//              resolves to nothing (e.g. the "precision-test" dev harness, or
//              the "game" default) is gated out HERE, so it never even sends a
//              request.
//   active     true only while the user is in a REAL gameplay session — the
//              same edge the page uses to record a play, never page load.
//   enabled    false opts a page out entirely. Used for spectators: on the
//              games that expose a view-only spectator route the match is
//              "in_progress" for the watcher too, so they must not be counted.
//   terminal   true once the session reached a final state (game over /
//              match finished). Beats stop immediately either way; `terminal`
//              additionally clears the row at once instead of letting it age
//              out of the activity window, so a result screen doesn't keep a
//              finished match "playing" for up to 3 minutes.
//
// Lifecycle
//   active → beat immediately, then every PRESENCE_HEARTBEAT_MS (60s)
//   active goes false (transient) → beats stop; the server's
//     ACTIVE_PLAYER_WINDOW_SECONDS (180s) window absorbs the gap. That is what
//     keeps a Crash Arena player counted between rounds without inventing a
//     per-game grace period.
//   terminal → beat + immediate leave
//   unmount (user navigated away) → immediate leave, scoped to this tab
//   browser closed / crashed → nothing is sent; the window expires the row
//
// Multiple tabs: the server UPSERTs on (user_id, game_key), so two tabs of the
// same game update ONE row and can never inflate the count. The per-tab
// session id only makes this tab's leave safe.
//
// Editing rules: this hook must stay strictly auxiliary. It reads no game
// state, writes nothing a game reads, keeps no UI, and swallows every failure
// (see src/lib/gamePresenceClient.js) — a presence outage cannot affect
// gameplay, bets, XP, rewards or matchmaking.

import { useEffect, useRef } from "react";
import { PRESENCE_HEARTBEAT_MS, isPresenceGame } from "../lib/gamePresence";
import {
  getPresenceSessionId,
  sendPresenceBeat,
  sendPresenceLeave,
} from "../lib/gamePresenceClient";

export default function useActiveGamePresence(
  gameLabel,
  active = false,
  { enabled = true, terminal = false } = {}
) {
  // A game the server would reject (or a page that opted out) sends nothing at
  // all — not even the leave. That is what makes a spectator free of presence
  // writes rather than just invisible in the count.
  const tracking = enabled !== false && isPresenceGame(gameLabel);
  const shouldBeat = tracking && Boolean(active);

  // Latest label for the unmount-only cleanup, which must not re-subscribe
  // (re-running it would fire a leave on every render).
  const latestRef = useRef({ gameLabel });
  latestRef.current = { gameLabel };

  // Lazily resolved inside effects, so SSR renders never touch sessionStorage.
  const sessionIdRef = useRef(null);
  const didBeatRef = useRef(false);

  // ── Heartbeat ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!shouldBeat) return undefined;

    const label = gameLabel;
    // One id per tab, shared by the beats and the (possible) leave below.
    if (sessionIdRef.current === null) sessionIdRef.current = getPresenceSessionId();
    const sessionId = sessionIdRef.current;
    let stopped = false;

    const beat = () => {
      if (stopped) return;
      didBeatRef.current = true;
      sendPresenceBeat(label, sessionId);
    };

    beat();
    const intervalId = setInterval(beat, PRESENCE_HEARTBEAT_MS);

    // Browsers throttle (or freeze) background timers, so a player returning to
    // a tab that was hidden for a while re-beats the moment it is visible again
    // instead of waiting out the interval. Same reasoning as the app-wide
    // presence heartbeat (src/components/PresenceHeartbeat.tsx).
    const onVisibilityChange = () => {
      if (typeof document === "undefined" || !document.hidden) beat();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", beat);

    return () => {
      stopped = true;
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", beat);
    };
  }, [shouldBeat, gameLabel]);

  // ── Terminal state: stop counting now, not in three minutes ────────────
  useEffect(() => {
    if (!tracking || !terminal) return undefined;
    if (sessionIdRef.current === null) sessionIdRef.current = getPresenceSessionId();
    sendPresenceLeave(gameLabel, sessionIdRef.current);
    return undefined;
  }, [tracking, terminal, gameLabel]);

  // ── Deliberate departure ───────────────────────────────────────────────
  // Navigating away stops the heartbeat (above) and clears this tab's row
  // immediately. Gated on "this mount actually beat", so a visitor who never
  // started a game writes nothing at all — including one that was opted out
  // for its whole life. A mount that beat and was then opted out mid-session
  // (a player eliminated from a live match) still clears its own row here:
  // the row is real and this mount owns it.
  useEffect(
    () => () => {
      if (!didBeatRef.current) return;
      sendPresenceLeave(latestRef.current.gameLabel, sessionIdRef.current);
    },
    []
  );
}

export { useActiveGamePresence };
