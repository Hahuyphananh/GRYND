"use client";

// src/app/casino/hex-duel/PageClient.tsx
//
// Hex Duel LOBBY. The board lives on its own route now
// (`/casino/hex-duel/game/<gameId>` for a staked duel, `/game/ai` for free
// practice), so this page does what every other casino lobby does: it creates
// the match and then navigates to it.
//
//   POST /api/hex-duel/multiplayer/create    open a staked PvP table
//   GET  /api/hex-duel/multiplayer/available open tables + live matches
//   POST /api/hex-duel/multiplayer/join      take the second seat
//   POST /api/hex-duel/start-game            mint the practice session
//
// The chrome is the shared `PvpLobbyPage` — the same component Ultimate
// Tic-Tac-Toe, Pool Masters and the rest mount — so the stake picker, the vs-AI
// button, the open-lobby list and the How-to-Play modal are the ones players
// already know.
//
// Nothing here decides a result: the stake is re-validated server-side
// (`requireStake`), both seats are escrowed by the join transaction alone, and
// a match settles from the server's replay of the accepted moves.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMatchRouter } from "../../../hooks/useMatchRouter";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { IconEye, IconHexagon } from "@tabler/icons-react";
import PvpLobbyPage, { formatTokens } from "../../../components/lobby/PvpLobby";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
  storeAiDifficulty,
} from "../../../lib/aiDifficulty";
import { useCoinBalance } from "../../../hooks/useCoinBalance";
import { startVisibleInterval } from "../../../hooks/useVisiblePoll";
import { WAGER_BY_KEY } from "../../../lib/defaultWagers";
import { PVP_WINNER_SHARE } from "../../../lib/games/economy";
import { MIN_STAKE } from "../../../lib/games/stakes";

/** One row of the available / live list. */
type HexLobbyRow = {
  id: number;
  hostClerkId?: string | null;
  hostName?: string | null;
  wagerAmount?: string | number | null;
  status?: string;
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

export default function HexDuelLobbyPage() {
  const router = useMatchRouter();
  const { user } = useUser();
  const posthog = usePostHog();
  const coinBalance = useCoinBalance();

  // The stake the next table opens at. The server re-validates it and the JOIN
  // escrows both seats, so this is a request and never a decision.
  const [stake, setStake] = useState<number>(
    () => Number(WAGER_BY_KEY["hex-duel"]) || 10,
  );
  const [busy, setBusy] = useState(false);
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [games, setGames] = useState<HexLobbyRow[]>([]);
  const [liveGames, setLiveGames] = useState<HexLobbyRow[]>([]);
  const [spectatorCounts, setSpectatorCounts] = useState<Record<number, number>>({});
  // False once the first response lands, so the empty state never flashes
  // before the request resolves.
  const [lobbiesLoading, setLobbiesLoading] = useState(true);

  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("hex-duel"),
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/hex-duel/multiplayer/available", {
        cache: "no-store",
      });
      const data = await res.json();
      const waiting: HexLobbyRow[] = Array.isArray(data?.games) ? data.games : [];
      const live: HexLobbyRow[] = Array.isArray(data?.liveGames) ? data.liveGames : [];
      setGames(waiting);
      setLiveGames(live);

      if (live.length > 0) {
        const counts: Record<number, number> = {};
        await Promise.all(
          live.map(async (g) => {
            try {
              const cr = await fetch(
                `/api/spectators/count?gameKey=hex-duel&gameId=${g.id}`,
                { credentials: "include" },
              );
              const cd = await cr.json();
              if (cd?.success) counts[g.id] = Number(cd.count) || 0;
            } catch {
              // A missing count is cosmetic — the Spectate button still works.
            }
          }),
        );
        setSpectatorCounts(counts);
      }
    } catch {
      // Silent: the poll retries. An action error is shown from `error`.
    } finally {
      setLobbiesLoading(false);
    }
  }, []);

  // This lobby has no Socket.IO room to lean on, so it keeps a real poll — but
  // a visibility-gated one: a hidden tab stops reading Postgres entirely.
  useEffect(() => {
    void load();
    return startVisibleInterval(load, 8000);
  }, [load]);

  // Legacy links: before the split, a match was `/casino/hex-duel?gameId=<id>`.
  // Anyone holding one (an open tab from before the deploy, a shared URL) is
  // moved to the match route with its seat flags intact, rather than landing on
  // the lobby and wondering where their game went.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const legacyId = Number(params.get("gameId"));
    if (!Number.isInteger(legacyId) || legacyId <= 0) return;
    const next = new URLSearchParams();
    for (const key of ["host", "spectator"]) {
      const value = params.get(key);
      if (value !== null) next.set(key, value);
    }
    const query = next.toString();
    router.replace(
      `/casino/hex-duel/game/${legacyId}${query ? `?${query}` : ""}`,
    );
  }, [router]);

  // The player's own open table, if they came back to the lobby after opening
  // one. `PvpLobby` shows it as a resumable banner instead of a Join button
  // (the server refuses a self-join anyway).
  const myOpenId = useMemo(() => {
    if (!user?.id) return null;
    return games.find((row) => row.hostClerkId === user.id)?.id ?? null;
  }, [games, user?.id]);

  const createGame = useCallback(async () => {
    if (busy) return;
    if (!(Number(stake) >= MIN_STAKE)) {
      setError(`Pick a stake of at least ${MIN_STAKE} coin to play.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/hex-duel/multiplayer/create", {
        method: "POST",
        // The proxy rejects a POST without a JSON content-type (415).
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ wager: Number(stake) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success || !data?.gameId) {
        setError(data?.error || "Unable to create the game");
        return;
      }
      posthog?.capture("hex_duel_lobby_action", {
        mode: "create",
        stake: Number(stake),
      });
      router.push(`/casino/hex-duel/game/${data.gameId}?host=1`);
    } catch {
      setError(UNREACHABLE);
    } finally {
      setBusy(false);
    }
  }, [busy, posthog, router, stake]);

  const joinGame = useCallback(
    async (row: HexLobbyRow) => {
      if (joiningId !== null) return;
      setJoiningId(row.id);
      setError(null);
      try {
        const res = await fetch("/api/hex-duel/multiplayer/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ gameId: row.id }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success || !data?.gameId) {
          setError(data?.error || "Unable to join that game");
          // The row may have been claimed a moment ago — re-read the list so
          // the stale entry disappears instead of inviting a second try.
          await load();
          return;
        }
        posthog?.capture("hex_duel_lobby_action", {
          mode: "join",
          stake: Number(row.wagerAmount) || 0,
        });
        router.push(`/casino/hex-duel/game/${data.gameId}?host=0`);
      } catch {
        setError(UNREACHABLE);
      } finally {
        setJoiningId(null);
      }
    },
    [joiningId, load, posthog, router],
  );

  const playAi = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // `start-game` mints the single-use AI session (and, for a signed-out
      // visitor, the practice identity). The match page forwards that token to
      // `/end-game`, which is what proves an AI claim instead of trusting it.
      const res = await fetch("/api/hex-duel/start-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isAiGame: true, aiDifficulty, wager: 0 }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to start the practice match");
        return;
      }
      storeAiDifficulty("hex-duel", aiDifficulty);
      const session = data?.data?.aiSessionId;
      const query = new URLSearchParams({ difficulty: aiDifficulty });
      if (typeof session === "string" && session.length > 0) {
        query.set("session", session);
      }
      posthog?.capture("hex_duel_lobby_action", { mode: "ai", difficulty: aiDifficulty });
      router.push(`/casino/hex-duel/game/ai?${query.toString()}`);
    } catch {
      setError(UNREACHABLE);
    } finally {
      setBusy(false);
    }
  }, [aiDifficulty, busy, posthog, router]);

  // Rules copy for the shared How-to-Play modal. Every number here is read
  // from the rulebook (3 AP per turn, 1 AP per action, 5 troops per capital)
  // rather than restated from memory, so the lobby cannot drift from the game.
  const rules = useMemo(
    () => ({
      title: "How to Play Hex Duel",
      sections: [
        {
          heading: "Hold the field, take the capital",
          body: (
            <>
              The board is a <b>5×5 grid</b> and each side starts with{" "}
              <b>five troops</b> in its capital. You win by taking the{" "}
              <b>enemy capital</b> — nothing else ends the match.
            </>
          ),
        },
        {
          heading: "Three actions a turn",
          body: (
            <>
              Every turn you get <b>3 action points</b>, and each action costs
              one: <b>attack</b> an adjacent enemy tile, <b>displace</b> troops
              between your own adjacent tiles, or <b>reinforce</b>. The board
              shows what you can still do, and <b>End Turn</b> hands the rest of
              your points over.
            </>
          ),
        },
        {
          heading: "Attacks are decided by troop counts",
          body: (
            <>
              Attacking with more troops than the defender holds{" "}
              <b>conquers the tile</b>, and the survivors stay on it. Equal
              stacks wipe each other out and leave the tile empty. Fewer troops
              means the attack fails and you lose the difference — so a stack you
              cannot beat is a wall, not a target.
            </>
          ),
        },
        {
          heading: "Capitals are the whole game",
          body: (
            <>
              A capital is a normal tile with an outsized consequence: the moment
              it changes hands, the match is over. That cuts both ways — never
              leave yours thin while you push elsewhere, and always check whether
              the tile next to it can reach you.
            </>
          ),
        },
        {
          heading: "Staked 1v1, or free practice",
          body: (
            <>
              A ranked duel plays for the stake you pick. Both stakes are escrowed
              when the second player joins and the winner takes{" "}
              <b>{2 * PVP_WINNER_SHARE}× their stake</b> (the house keeps 10% of
              the pot). A table nobody joins costs nothing, and practice against
              the bot is always free and unrated.
            </>
          ),
        },
      ],
    }),
    [],
  );

  return (
    <PvpLobbyPage
      title="Hex Duel"
      subtitle="A ranked 1v1 duel on a 5×5 hex grid. Three actions a turn, attacks decided by troop counts, and the match ends the moment a capital falls. Or practise against the bot for free."
      icon={
        <IconHexagon className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />
      }
      rulesKey="hex-duel"
      rules={rules}
      wager={{ value: stake, onChange: setStake, balance: coinBalance, label: "Stake per seat" }}
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
        busy,
        disabled: false,
      }}
      myOpenId={myOpenId}
      onResume={(id: number) => router.push(`/casino/hex-duel/game/${id}?host=1`)}
      lobbies={games}
      lobbiesLoading={lobbiesLoading}
      lobbyKey={(row: HexLobbyRow) => row.id}
      lobbyTitle={(row: HexLobbyRow) => <>Table #{row.id}</>}
      lobbyMeta={(row: HexLobbyRow) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Host: {row.hostName || "Player"}</span>
          <span className="font-semibold text-amber-300">
            Stake: {stakeLabel(row.wagerAmount)}
          </span>
        </span>
      )}
      onJoin={joinGame}
      joinBusyId={joiningId}
      joinLabel="Join"
      lobbyEmptyText="No open Hex Duel tables right now. Create one and an opponent will be matched in."
      onRefresh={load}
      historyHref="/casino/hex-duel/history"
      error={error}
      children={
        <div className="mt-5 border-t border-white/10 pt-4">
          <AiDifficultyPicker
            gameKey="hex-duel"
            value={aiDifficulty}
            onChange={setAiDifficulty}
            hint={{
              easy: "The bot attacks almost at random and often leaves its capital open.",
              normal: "The bot takes free captures and defends when threatened, but still slips.",
              hard: "The bot hunts exposed stacks and guards its capital every turn.",
            }}
          />
        </div>
      }
      after={
        /* Live matches: the same card chrome as the lobby list above, kept
           separate because a running game has a different action (spectate)
           and a spectator count. */
        <div className="mt-6 rounded-2xl border border-amber-700/60 bg-black/40 p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-lg font-bold uppercase tracking-wider text-cyan-300">
              <IconEye size={16} />
              Live Games
            </h2>
            <button
              type="button"
              onClick={load}
              className="rounded-lg border border-white/15 px-3 py-1 text-[11px] font-semibold text-white/60 transition hover:border-cyan-400/40 hover:text-white"
            >
              Refresh
            </button>
          </div>
          {liveGames.length === 0 ? (
            <p className="py-3 text-center text-sm text-white/45">
              No Hex Duel matches running right now.
            </p>
          ) : (
            <ul className="space-y-2">
              {liveGames.map((g) => (
                <li
                  key={g.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan-700/30 bg-slate-900/80 px-3 py-2.5 transition hover:border-cyan-500/50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-white/90">
                      Table #{g.id} · {g.hostName || "Player"} vs Opponent
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/60">
                      <span className="font-semibold text-amber-300">
                        Stake: {stakeLabel(g.wagerAmount)}
                      </span>
                      {spectatorCounts[g.id] > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/15 px-2 py-0.5 text-[10px] font-bold text-purple-300">
                          <IconEye size={11} /> {spectatorCounts[g.id]}
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      router.push(`/casino/hex-duel/game/${g.id}?spectator=1`)
                    }
                    className="rounded-lg border border-purple-400/40 px-4 py-1.5 text-sm font-bold text-purple-200 transition hover:bg-purple-500/20"
                  >
                    Spectate
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      }
    />
  );
}
