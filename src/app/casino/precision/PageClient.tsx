"use client";

// ── Lobby page for the Precision PvP casino game ─────────────────────────
//
// Mirrors the architecture of the other casino PvP lobbies:
//   * Top-level wager picker + PvP create button (shared PvpLobbyPage
//     chrome — blackjack layout, farkle palette)
//   * Live list of open lobbies (polled every 3s)
//   * On "Create PvP", redirect to /casino/precision/game/[lobbyId] which
//     then renders the waiting room while the host waits for an opponent.
//   * On "Test Mode", redirect to /casino/precision/test — a self-contained
//     solo reaction-time sandbox that runs entirely client-side (no wager,
//     no opponent, no server interaction). See that page's header comment
//     for the rationale.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useUser } from "@clerk/nextjs";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import { CoinIcon } from "../../../components/lobby/PvpLobby";
import { IconTarget } from "@tabler/icons-react";
import { useTranslation } from "../../../hooks/useTranslation";
import {
  createLobby,
  joinLobby,
  listLobbies,
  emitLobbyListUpdate,
} from "../../../lib/precision/multiplayer";
import { useSocket } from "../../../context/SocketProvider";
import { LOBBY_LIST_POLL_INTERVAL_MS } from "../../../lib/precision/constants";
import type { PrecisionLobby } from "../../../lib/precision/types";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
} from "../../../lib/aiDifficulty";

export default function PrecisionLobbyPage() {
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();
  const { t } = useTranslation();
  const { isSignedIn, user } = useUser();
  const [lobbies, setLobbies] = useState<PrecisionLobby[]>([]);
  // STAKES ARE RETIRED (src/lib/games/stakes.js): a lobby is free to open,
  // so there is no wager to pick and no token balance to load.
  const wager = 0;
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The AI tier the bot stops at, chosen in this lobby and remembered per
  // game by the picker; sent with the create-ai request.
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("precision"),
  );

  // Subscribe to lobby-list updates pushed by other clients via the
  // realtime server. Mirrors the Uno `lobby:uno` room pattern.
  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:precision";
    socket.emit("join_room", { roomId });
    socket.on("precision:lobby:updated", () => {
      void reload();
    });
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("precision:lobby:updated");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  const reload = async () => {
    try {
      const list = await listLobbies();
      setLobbies(list);
    } catch {
      // ignore — list will be retried on the next interval
    }
  };

  /**
   * Display name for the local player's seat. Display only — the server
   * derives every player's IDENTITY from the Clerk session; this is what
   * the opponent sees on the seat card.
   */
  const displayName =
    user?.username ||
    user?.fullName ||
    user?.firstName ||
    (isSignedIn ? "Player" : "You");

  /**
   * Write the locally owned seat ("1" or "2") to sessionStorage. The
   * match page reads this on mount so it knows which player record is
   * "self" — auth hasn't landed in the scaffold yet.
   */
  const persistLocalSeat = (seat: 1 | 2) => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem("precision:localSeat", String(seat));
    } catch {
      // sessionStorage may be unavailable (private mode, sandboxed iframe)
      // — silence the error so the navigation still fires.
    }
  };

  // Poll the public lobby list as a fallback for clients that miss the
  // realtime nudge.
  useEffect(() => {
    void reload();
    const id = setInterval(() => {
      void reload();
    }, LOBBY_LIST_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const handleCreatePvP = async () => {
    setCreating(true);
    setError(null);
    try {
      // Staked PvP matchmaking needs a signed-in player: the server seats
      // the host from the Clerk session (it never trusts a client-sent id),
      // so an anonymous caller would be rejected anyway — fail fast with a
      // readable message instead of a raw 401.
      if (!isSignedIn) {
        setError("Sign in to play a staked Precision duel.");
        return;
      }
      posthog?.capture("precision_find_match", { wager, mode: "pvp" });
      const res = await createLobby({ wager, gameMode: "pvp", hostName: displayName });
      if (!res.success || !res.gameId) {
        setError(res.error ?? t("games.precision.match_unavailable"));
        return;
      }
      posthog?.capture("precision_matchmaking_status", {
        status: res.status,
        wager,
        opponentUserId: res.opponent?.userId,
      });
      // Record which seat we own so the match page can decide whether
      // WE are the Ready button. "waiting" = host = seat 1, "matched" =
      // joiner (we found an existing wait) = seat 2.
      persistLocalSeat(res.status === "matched" ? 2 : 1);
      if (res.status !== "waiting") {
        emitLobbyListUpdate(socket);
      }
      router.push(`/casino/precision/game/${res.gameId}`);
    } finally {
      setCreating(false);
    }
  };

  // The Test button is a plain `<Link>` navigation, not a server call.
  // See `src/app/casino/precision/test/page.tsx` for the solo sandbox.
  // We capture analytics on click so the funnel / "test_to_pvp"
  // conversion ratio can be measured without leaning on hover-tracking.
  const handlePlayAi = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/precision/create-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ difficulty: aiDifficulty }),
      });
      const data = await res.json();
      if (!res.ok || !data.success || !data.matchId) {
        setError(data.error ?? "Unable to start AI match");
        return;
      }
      persistLocalSeat(1);
      router.push(`/casino/precision/game/${data.matchId}`);
    } finally {
      setCreating(false);
    }
  };

  const handleTestClick = () => {
    posthog?.capture("precision_test_clicked", { source: "lobby" });
  };

  const handleJoin = async (lobby: PrecisionLobby) => {
    setJoining(String(lobby.id));
    setError(null);
    try {
      const res = await joinLobby(String(lobby.id), displayName);
      if (!res.success || !res.matchId) {
        setError(res.error ?? t("games.precision.join_failed"));
        return;
      }
      // Joining an open lobby from the public list means we're the
      // joiner (seat 2). The lobby's host is already seat 1.
      persistLocalSeat(2);
      emitLobbyListUpdate(socket);
      router.push(`/casino/precision/game/${res.matchId}`);
    } finally {
      setJoining(null);
    }
  };

  return (
    <PvpLobbyPage
      title={t("games.precision.lobby_page_title")}
      subtitle={
        <>
          {t("games.precision.lobby_page_subtitle")}{" "}
          {t("games.precision.ready_explainer", {
            ready: t("games.precision.test_solo_label"),
          })}
        </>
      }
      icon={<IconTarget className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />}
      rulesKey="precision"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "Stop on target",
            body: (
              <>
                A target time is shown next to a running timer. Press
                STOP as close to the target as you can. The smaller the
                miss, the better your rank.
              </>
            ),
          },
          {
            heading: "5-second countdown",
            body: (
              <>
                Once both players are ready, a 5-second countdown runs
                (5…4…3…2…1). The target appears and the timer starts the
                moment it hits zero. No early clicks.
              </>
            ),
          },
          {
            heading: "1v1 duel",
            body: (
              <>
                Face another player at the same stake. Both players stop
                independently. The round goes to whoever stopped
                closest to the target. First to 3 rounds wins the match
                and the pot (minus the platform fee).
              </>
            ),
          },
          {
            heading: "Practice free",
            body: (
              <>
                Use {t("games.precision.test_solo_label")} to practice
                with no tokens at stake.
              </>
            ),
          },
        ],
      }}
      busy={creating}
      onPlay={handleCreatePvP}
      playLabel={t("games.precision.create_pvp_game")}
      playBusyLabel={t("games.precision.creating")}
      children={
        <AiDifficultyPicker
          gameKey="precision"
          value={aiDifficulty}
          onChange={setAiDifficulty}
          hint={{
            easy: "The bot is slow and sloppy — it will usually stop well off the target.",
            normal: "The bot's stop error is the band it always shipped with.",
            hard: "The bot stops almost exactly on the target.",
          }}
        />
      }
      extraActions={
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handlePlayAi}
            disabled={!isSignedIn || creating}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-fuchsia-500/40 bg-fuchsia-500/10 py-2 text-sm font-bold text-fuchsia-200 transition hover:bg-fuchsia-500/20 disabled:opacity-50"
          >
            Play Free vs AI
          </button>
          <Link
          href="/casino/precision/test"
          data-testid="precision-test-link"
          onClick={handleTestClick}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 py-2 text-sm font-bold text-cyan-200 transition hover:bg-cyan-500/20"
        >
          <IconTarget size={16} />
          {t("games.precision.test_solo_label")} (
          {t("games.precision.no_wager_label").toLowerCase()})
          </Link>
        </div>
      }
      lobbies={lobbies}
      lobbyEmptyText={t("games.precision.no_open_lobbies")}
      lobbyKey={(l) => l.id}
      lobbyTitle={(l) => (
        <>
          Lobby <span className="font-mono">#{l.id}</span>
        </>
      )}
      lobbyMeta={(l) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            {t("games.precision.wager_label")}:{" "}
            <span className="inline-flex items-center gap-1 font-semibold text-yellow-300">
              {Number(l.wager).toLocaleString()}
              <CoinIcon className="h-3.5 w-3.5 text-yellow-300" />
            </span>
          </span>
          <span className="text-white/40">
            PvP · {t("games.precision.waiting_for_player")}
          </span>
        </span>
      )}
      onJoin={handleJoin}
      joinBusyId={joining}
      joinLabel={t("games.precision.join_game")}
      onRefresh={reload}
      error={error}
    />
  );
}
