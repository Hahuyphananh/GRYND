"use client";

// src/app/casino/odds/PageClient.tsx
//
// Odds LOBBY. The board lives on its own route now
// (`/casino/odds/game/<id>` for a staked duel, `/casino/odds/game/ai` for free
// practice), so this page does what every other casino lobby does: it creates
// or joins the match and then navigates to it.
//
//   POST /api/odds/create     open a staked PvP table
//   GET  /api/odds/available  the open tables
//   POST /api/odds/join       take the second seat
//   POST /api/odds/cancel     close your own unmatched table
//   GET  /api/odds/pvp/status resume a duel that is already in progress
//
// The chrome is the shared `PvpLobbyPage` — the same component Hex Duel, Tower
// Arena and the rest mount — so the stake picker, the vs-AI button, the open
// lobby list and the How-to-Play modal are the ones players already know.
//
// Nothing here decides a result: the stake is re-validated server-side
// (`requireStake`), both seats are escrowed by the join transaction alone, and
// every pick is resolved on the server.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { IconDice } from "@tabler/icons-react";
import PvpLobbyPage, { formatTokens } from "../../../components/lobby/PvpLobby";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
  storeAiDifficulty,
} from "../../../lib/aiDifficulty";
import { useCoinBalance } from "../../../hooks/useCoinBalance";
import { startVisibleInterval } from "../../../hooks/useVisiblePoll";
import { useSocket } from "../../../context/SocketProvider";
import { WAGER_BY_KEY } from "../../../lib/defaultWagers";
import { PVP_WINNER_SHARE } from "../../../lib/games/economy";
import { MIN_STAKE } from "../../../lib/games/stakes";

/** One row of the open-table list (shape of /api/odds/available). */
type OddsLobbyRow = {
  id: number;
  player1Id?: string | null;
  player1Name?: string | null;
  wager?: string | number | null;
  createdAt?: string;
};

/**
 * What a failed action says when no response ever came back.
 *
 * A dropped connection and a cross-origin redirect both surface as a rejected
 * `fetch`; neither is the player's fault, so the copy names the one thing that
 * actually helps (retry, then reload).
 */
const UNREACHABLE =
  "Couldn't reach the server. Try again, and reload the page if it keeps failing.";

/** Format a stake cell: a legacy 0-stake row reads as free practice. */
function stakeLabel(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `${formatTokens(n)} coins` : "Free play";
}

export default function OddsLobbyPage() {
  const router = useRouter();
  const { user } = useUser();
  const posthog = usePostHog();
  const coinBalance = useCoinBalance();
  const { socket } = useSocket();

  // The stake the next table opens at. The server re-validates it and the JOIN
  // escrows both seats, so this is a request and never a decision.
  const [stake, setStake] = useState<number>(
    () => Number(WAGER_BY_KEY["odds"]) || 10,
  );
  const [busy, setBusy] = useState(false);
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [lobbies, setLobbies] = useState<OddsLobbyRow[]>([]);
  // False once the first response lands, so the empty state never flashes
  // before the request resolves.
  const [lobbiesLoading, setLobbiesLoading] = useState(true);

  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("odds"),
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/odds/available", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      const rows: OddsLobbyRow[] = Array.isArray(data?.data?.games)
        ? data.data.games
        : [];
      setLobbies(rows);
    } catch {
      // Silent: the poll retries. An action error is shown from `error`.
    } finally {
      setLobbiesLoading(false);
    }
  }, []);

  // This lobby has no server push of its own, so it keeps a poll — but a
  // visibility-gated one: a hidden tab stops reading Postgres entirely. The
  // socket room below is only an "a table changed" ping that reads sooner.
  useEffect(() => {
    void load();
    return startVisibleInterval(load, 8000);
  }, [load]);

  useEffect(() => {
    if (!socket) return undefined;
    const roomId = "lobby:odds";
    socket.emit("join_room", { roomId });
    const refresh = () => void load();
    socket.on("lobby:updated", refresh);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", refresh);
    };
  }, [socket, load]);

  // A duel that is already running is where the player wants to be, not the
  // lobby. (The lobby never creates on load; it only forwards to the route
  // that owns the match.)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/odds/pvp/status", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (cancelled || !data?.success || !data.data?.active) return;
        if (data.data.status !== "playing" || !data.data.gameId) return;
        router.replace(`/casino/odds/game/${data.data.gameId}`);
      } catch {
        // No resume is fine: the open-table list and the Play button remain.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // The player's own open table, if they came back to the lobby after opening
  // one. `PvpLobby` shows it as a resumable banner instead of a Join button
  // (the server refuses a self-join anyway).
  const myOpenId = useMemo(() => {
    if (!user?.id) return null;
    return lobbies.find((row) => row.player1Id === user.id)?.id ?? null;
  }, [lobbies, user?.id]);

  const createGame = useCallback(async () => {
    if (busy) return;
    if (!(Number(stake) >= MIN_STAKE)) {
      setError(`Pick a stake of at least ${MIN_STAKE} coin to play.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/odds/create", {
        method: "POST",
        // The proxy rejects a POST without a JSON content-type (415).
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ wager: Number(stake), isAi: false }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success || !data?.data?.gameId) {
        setError(data?.error || "Unable to create the game");
        return;
      }
      posthog?.capture("odds_lobby_action", {
        mode: "create",
        stake: Number(stake),
      });
      router.push(`/casino/odds/game/${data.data.gameId}`);
    } catch {
      setError(UNREACHABLE);
    } finally {
      setBusy(false);
    }
  }, [busy, posthog, router, stake]);

  const joinGame = useCallback(
    async (row: OddsLobbyRow) => {
      if (joiningId !== null) return;
      setJoiningId(row.id);
      setError(null);
      try {
        const res = await fetch("/api/odds/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          // The stake travels with the join so the server can prove the seat is
          // escrowed at the amount the lobby row showed.
          body: JSON.stringify({ gameId: row.id, wager: Number(row.wager) }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success || !data?.data?.gameId) {
          setError(data?.error || "Unable to join that game");
          // The row may have been claimed a moment ago — re-read the list so
          // the stale entry disappears instead of inviting a second try.
          await load();
          return;
        }
        posthog?.capture("odds_lobby_action", {
          mode: "join",
          stake: Number(row.wager) || 0,
        });
        // Tell the waiting host's match page that the seat is taken — it is
        // subscribed to the lobby room and re-reads its own game on the ping.
        socket?.emit("room_event", { roomId: "lobby:odds", event: "lobby:updated" });
        router.push(`/casino/odds/game/${data.data.gameId}`);
      } catch {
        setError(UNREACHABLE);
      } finally {
        setJoiningId(null);
      }
    },
    [joiningId, load, posthog, router, socket],
  );

  const cancelGame = useCallback(
    async (gameId: number) => {
      if (cancellingId !== null) return;
      setCancellingId(gameId);
      setError(null);
      try {
        const res = await fetch("/api/odds/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ gameId }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          setError(data?.error || "Unable to cancel that table");
        }
        await load();
        socket?.emit("room_event", { roomId: "lobby:odds", event: "lobby:updated" });
      } catch {
        setError(UNREACHABLE);
      } finally {
        setCancellingId(null);
      }
    },
    [cancellingId, load, socket],
  );

  const playAi = useCallback(() => {
    // Practice needs no table and no stake: the match route mints the session
    // when it opens. The tier is remembered per device for the next visit.
    storeAiDifficulty("odds", aiDifficulty);
    posthog?.capture("odds_lobby_action", { mode: "ai", difficulty: aiDifficulty });
    router.push(
      `/casino/odds/game/ai?difficulty=${encodeURIComponent(aiDifficulty)}`,
    );
  }, [aiDifficulty, posthog, router]);

  // Rules copy for the shared How-to-Play modal. Every number comes from the
  // rulebook (6 rounds, the range halving) rather than being restated from
  // memory, so the lobby cannot drift from the game.
  const rules = useMemo(
    () => ({
      title: "How to Play Odds",
      sections: [
        {
          heading: "Two-phase prediction duel",
          body: (
            <>
              Each round you <b>pick a hidden number</b>, then{" "}
              <b>predict your opponent&apos;s number</b>. Both picks stay hidden
              until the reveal.
            </>
          ),
        },
        {
          heading: "Band scoring",
          body: (
            <>
              The closer your predictions, the more points you score. Hitting
              the exact band pays the most.
            </>
          ),
        },
        {
          heading: "Shrinking range",
          body: (
            <>
              The number range <b>halves each round</b> over 6 rounds. Later
              rounds are higher-stakes.
            </>
          ),
        },
        {
          heading: "Win the match",
          body: (
            <>
              The player with the most points after all rounds takes the pot. A
              staked duel escrows both seats when the second player joins and
              the winner takes <b>{2 * PVP_WINNER_SHARE}× their stake</b> (the
              house keeps 10% of the pot). Practice against the bot is always
              free.
            </>
          ),
        },
      ],
    }),
    [],
  );

  return (
    <PvpLobbyPage
      title="Odds"
      subtitle="A ranked 1v1 prediction duel: lock a hidden number, read your opponent's, and score each round as the range halves from 100 to 3. Or practise against the bot for free."
      icon={
        <IconDice className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />
      }
      rulesKey="odds"
      rules={rules}
      wager={{ value: stake, onChange: setStake, balance: coinBalance }}
      busy={busy}
      onPlay={createGame}
      playLabel={`Create PvP Game · ${formatTokens(stake)} coins`}
      playBusyLabel="Opening table…"
      canPlay={stake >= MIN_STAKE}
      waitingSubtitle={`Pairing you at ${formatTokens(stake)} coins — both stakes are escrowed the moment an opponent joins.`}
      vsAi={{
        label: "Play vs AI",
        badge: "Free",
        onClick: playAi,
        busy: false,
        disabled: false,
      }}
      myOpenId={myOpenId}
      onResume={(id: number) => router.push(`/casino/odds/game/${id}`)}
      onCancel={cancelGame}
      cancelling={cancellingId !== null}
      lobbies={lobbies}
      lobbiesLoading={lobbiesLoading}
      lobbyKey={(row: OddsLobbyRow) => row.id}
      lobbyTitle={(row: OddsLobbyRow) => <>Table #{row.id}</>}
      lobbyMeta={(row: OddsLobbyRow) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Host: {row.player1Name || "Player"}</span>
          <span className="font-semibold text-amber-300">
            Stake: {stakeLabel(row.wager)}
          </span>
        </span>
      )}
      onJoin={joinGame}
      joinBusyId={joiningId}
      joinLabel="Join"
      lobbyEmptyText="No open Odds tables right now. Create one and an opponent will be matched in."
      onRefresh={load}
      error={error}
      children={
        <div className="mt-5 border-t border-white/10 pt-4">
          <AiDifficultyPicker
            gameKey="odds"
            value={aiDifficulty}
            onChange={setAiDifficulty}
            hint={{
              easy: "The bot guesses at random and almost never reads your habit.",
              normal: "The bot mixes guesses with the occasional read on your pattern.",
              hard: "The bot studies your picks and predicts your number most rounds.",
            }}
          />
        </div>
      }
    />
  );
}
