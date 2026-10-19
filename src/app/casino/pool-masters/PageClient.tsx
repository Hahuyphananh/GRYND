"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { WAGER_BY_KEY } from "../../../lib/defaultWagers";
import { PVP_WINNER_SHARE } from "../../../lib/games/economy";
import PvpLobbyPage, { formatTokens } from "../../../components/lobby/PvpLobby";
import { IconTarget } from "@tabler/icons-react";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import { type AiDifficulty, readStoredAiDifficulty } from "../../../lib/aiDifficulty";
import { startVisibleInterval } from "../../../hooks/useVisiblePoll";


/**
 * What every failed action says when no response ever arrived.
 *
 * Deliberately action-oriented: the request has already been retried once, so
 * the only useful next step is a reload (a stale service worker or a session
 * that needs re-establishing is cleared by one).
 */
const UNREACHABLE =
  "Couldn't reach the server. Try again, and reload the page if it keeps failing.";

/**
 * POST a JSON body and read the JSON reply.
 *
 * A browser `fetch` REJECTS with `TypeError: Failed to fetch` whenever no
 * response is ever produced — a dropped connection, or a request that had to
 * hop to another origin (a deployment that serves the app on a host which
 * 308-redirects to the other one: the redirected response carries no CORS
 * headers, so the browser discards it instead of handing it to the app).
 * Neither is the player's fault, and both are usually momentary, so the request
 * is retried ONCE before the action reports it.
 *
 * This is the call the lobby buttons were MISSING: they ran `try { fetch }
 * finally {}`, so a rejection was neither retried, nor shown, nor caught — the
 * click logged an uncaught promise error and otherwise did nothing at all.
 *
 * The reply is returned as-is (or null when the body is not JSON). The pool
 * routes answer a refusal with `{ ok: false, message }` — never `error` — so the
 * callers below read BOTH shapes; reading only `error` dropped the server's own
 * explanation ("Wager must be …", "Insufficient …") on the floor.
 */
type PoolLobbyReply = {
  lobbyId?: string;
  matchId?: string;
  firstTurnSeat?: number;
  error?: string;
  message?: string;
};

async function postPoolJson(
  path: string,
  body: unknown,
): Promise<PoolLobbyReply | null> {
  let failure: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // A non-JSON body (an error page from the platform, say) must not surface
      // as a confusing SyntaxError out of the action.
      return (await res.json().catch(() => null)) as PoolLobbyReply | null;
    } catch (error) {
      failure = error;
      // One retry, a beat later: a cold function, a dropped socket or a
      // session refresh that terminated the hop all succeed on the second try.
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw failure;
}

export default function PoolLobbyPage() {
  const router = useRouter();
  const [lobbies, setLobbies] = useState<any[]>([]);
  // False once the first list response lands, so the empty state never
  // flashes before the request resolves.
  const [lobbiesLoading, setLobbiesLoading] = useState(true);
  // THE STAKE THE LOBBY OPENS AT. The server re-validates it
  // (`requireStake`), stores it on the lobby and escrows BOTH seats when an
  // opponent joins; the winner takes 1.8× (the house keeps 10% of the pot).
  const [wager, setWager] = useState<number>(
    () => Number(WAGER_BY_KEY["pool-masters"]) || 10,
  );
  const [loading, setLoading] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdLobbyId, setCreatedLobbyId] = useState<string | null>(null);
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("pool-masters")
  );

  const load = async () => {
    try {
      const res = await fetch("/api/pool/lobbies", { cache: "no-store" });
      const data = await res.json();
      setLobbies(data.lobbies || []);
    } catch {
      // silent — poll retries next tick
    } finally {
      setLobbiesLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Visibility-gated: a hidden lobby tab stops polling Postgres. This page is
    // the one lobby with no Socket.IO room to lean on, so it keeps a real poll;
    // the cadence is relaxed to 5s (it was 3s) as a floor until a lobby room is
    // added — see the runtime notes.
    return startVisibleInterval(load, 5000);
  }, []);
  useEffect(() => {
    if (!createdLobbyId) return;
    // Visibility-gated: nobody is waiting on a match from a background tab.
    // Relaxed from 1.2s to 3s: this is the match-found watch, and 3s is still
    // well inside the lobby's ready window while cutting these reads ~2.5x.
    return startVisibleInterval(async () => {
      const res = await fetch(`/api/pool/get-match?matchId=${createdLobbyId}`, {
        cache: "no-store",
      });
      const data = await res.json();
      const match = data?.match;
      if (match?.status === "active" && match?.id && match.id !== createdLobbyId) {
        router.push(`/casino/pool-masters/game/${match.id}`);
      }
    }, 3000);
  }, [createdLobbyId, router]);

  const createLobby = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await postPoolJson("/api/pool/create-lobby", { wager });
      if (!data?.lobbyId) {
        setError(data?.error || data?.message || "Unable to create lobby");
        return;
      }
      setCreatedLobbyId(data.lobbyId);
      router.push(`/casino/pool-masters/game/${data.lobbyId}`);
    } catch {
      setError(UNREACHABLE);
    } finally {
      setLoading(false);
    }
  };

  const joinLobby = async (lobby: any) => {
    setJoiningId(lobby.id);
    setError(null);
    try {
      const data = await postPoolJson("/api/pool/join-lobby", { lobbyId: lobby.id });
      if (!data?.matchId) {
        setError(data?.error || data?.message || "Unable to join lobby");
        return;
      }
      router.push(`/casino/pool-masters/game/${data.matchId}`);
    } catch {
      setError(UNREACHABLE);
    } finally {
      setJoiningId(null);
    }
  };

  const createAI = async () => {
    setLoading(true);
    setError(null);
    try {
      // Practice stays free: the AI seat holds no pot, so no stake is sent.
      const data = await postPoolJson("/api/pool/create-ai-match", { wager: 0 });
      if (!data?.matchId) {
        setError(data?.error || data?.message || "Unable to start AI match");
        return;
      }
      router.push(
        `/casino/pool-masters/game/${data.matchId}?ai=1&turn=${data.firstTurnSeat ?? 1}&difficulty=${aiDifficulty}`,
      );
    } catch {
      setError(UNREACHABLE);
    } finally {
      setLoading(false);
    }
  };

  return (
    <PvpLobbyPage
      title="Pool Masters Lobby"
      subtitle="Create or join a 1v1 pool match, or play the AI for free."
      icon={<IconTarget className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />}
      rulesKey="pool-masters"
      rules={{
        title: "How to Play",
        sections: [
          {
            heading: "1v1 8-ball pool",
            body: (
              <>
                Compete head-to-head over a free game of 8-ball pool.
                Take turns shooting. Pocket your group of balls, then the
                8-ball to win the match.
              </>
            ),
          },
          {
            heading: "Coins",
            body: (
              <>
                A ranked 1v1 match plays for the stake you pick. Both stakes
                are escrowed when the second player joins, and the winner takes
                <b> {2 * PVP_WINNER_SHARE}× their stake</b> (the house keeps
                10% of the pot). A loss costs exactly the stake you agreed to.
                Results still count towards your Elo and Pool trophies.
              </>
            ),
          },
          {
            heading: "Practice free",
            body: (
              <>
                Play vs AI at no cost to learn the game first.
              </>
            ),
          },
        ],
      }}
      wager={{
        value: wager,
        onChange: setWager,
        min: 1,
        max: 100,
        label: "Stake",
      }}
      busy={loading}
      onPlay={createLobby}
      playLabel={wager > 0 ? `Create Game · ${wager} coins` : "Create PvP Game"}
      playBusyLabel="Creating lobby…"
      vsAi={{
        label: "Play vs AI",
        badge: "Free",
        disabled: false,
        busy: loading,
        onClick: createAI,
      }}
      children={
        <AiDifficultyPicker
          gameKey="pool-masters"
          value={aiDifficulty}
          onChange={setAiDifficulty}
          hint={{
            easy: "The bot misses badly and often shoots the wrong ball.",
            normal: "The bot aims well by default, with the occasional slip.",
            hard: "The bot always takes the nearest ball and barely misses.",
          }}
        />
      }
      lobbies={lobbies}
      lobbiesLoading={lobbiesLoading}
      lobbyEmptyText="No open lobbies yet. Be the first to make one."
      lobbyKey={(l) => l.id}
      lobbyTitle={(l) => (
        <>
          Lobby <span className="font-mono">{String(l.id).slice(-12)}</span>
        </>
      )}
      lobbyMeta={(l) => (
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold text-amber-300">
            {Number(l.wager) > 0
              ? `${formatTokens(l.wager)} coins`
              : "Free play"}
          </span>
          <span className="capitalize">Mode: {l.gameMode}</span>
          <span className="text-white/40">Waiting for player</span>
        </span>
      )}
      onJoin={joinLobby}
      joinBusyId={joiningId}
      onRefresh={load}
      error={error}
    />
  );
}
