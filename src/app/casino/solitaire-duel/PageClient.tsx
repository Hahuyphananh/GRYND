"use client";

// src/app/casino/solitaire-duel/PageClient.tsx
//
// Solitaire Duel lobby.
//
// The page reuses the shared casino lobby chrome (`PvpLobbyPage`) — the same
// component every other 1v1 game mounts — so the page, its rules modal, its
// navigation bar, its footer and its platform Quick Queue panel are the
// EXISTING ones, not a new lobby system.
//
// One entry point: POST /api/solitaire-duel/create-or-join, which is the
// store's own `createOrJoin` (per-game advisory lock + FOR UPDATE) either
// joining the oldest open lobby or opening one. The server mints the seed and
// derives the single shared deal at row creation, so the lobby has nothing to
// decide about the puzzle.
//
// Where a pairing lands: `./[matchId]/PageClient` — the race itself. It waits
// for the opponent, counts down from the server's absolute GO instant, renders
// the server's board, streams the server-derived opponent progress, and hands
// off to the shared `PvpResultScreen` with the SNAPSHOT's verdict. Nothing on
// either screen decides a result.
//
// Solitaire Duel is unstaked — the platform retired stakes and this game never
// had one — so there is no wager picker, no balance and no escrow note anywhere
// on this screen.

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { IconCards } from "@tabler/icons-react";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
} from "../../../lib/aiDifficulty";

export default function SolitaireDuelLobbyPage() {
  const { isSignedIn } = useUser();
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("solitaire-duel"),
  );

  const createOrJoin = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/solitaire-duel/create-or-join", {
        method: "POST",
        // The proxy rejects POSTs without a JSON content-type (415), even
        // bodyless ones — declare it so matchmaking reaches the route.
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to find a match");
        return;
      }
      router.push(`/casino/solitaire-duel/${data.data.matchId}`);
    } catch {
      setError("Unable to find a match");
    } finally {
      setBusy(false);
    }
  }, [busy, router]);

  const playAi = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/solitaire-duel/create-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ difficulty: aiDifficulty }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to start the practice match");
        return;
      }
      router.push(`/casino/solitaire-duel/${data.data.matchId}`);
    } catch {
      setError("Unable to start the practice match");
    } finally {
      setBusy(false);
    }
  }, [aiDifficulty, busy, router]);

  const rules = useMemo(
    () => ({
      title: "How to Play Solitaire Duel",
      sections: [
        {
          heading: "One deal, two players, same puzzle",
          body: (
            <>
              The server generates <b>one deterministic Klondike deal</b> and
              hands the <b>exact same starting position</b> to both players:
              identical tableau, identical face-up and face-down cards,
              identical stock and waste order. You play your own copy — you
              cannot see, touch or interfere with your opponent&apos;s board.
            </>
          ),
        },
        {
          heading: "First to solve it wins",
          body: (
            <>
              Build all four foundations from Ace to King. The{" "}
              <b>first player to put all 52 cards on the foundations wins
              immediately</b> — the server verifies the completion from its own
              board, so a board that merely looks finished locally is not a win.
            </>
          ),
        },
        {
          heading: "No clock — but don't go idle",
          body: (
            <>
              A match has <b>no time limit</b>: it ends when someone solves the
              deal, concedes, or disconnects. To keep a race from stalling, a
              seat that makes no move for <b>15 minutes</b> is warned, and one
              that stays idle for <b>20 minutes forfeits</b> — the opponent takes
              the win. The clock and the result are the server&apos;s.
            </>
          ),
        },
        {
          heading: "How you play",
          body: (
            <>
              Click a card to pick it up, then click a highlighted pile to place
              it — a run, a single card, or the top of the waste. Click the stock
              to draw, and click the {"\u21bb"} slot to turn an exhausted waste
              back over. A face-down card flips by itself the moment the card
              above it leaves. Every move is validated by the server before it
              counts.
            </>
          ),
        },
        {
          heading: "Simultaneous play — and the server decides",
          body: (
            <>
              Both players play at the same time, each on their own board, and
              neither can see or affect the other&apos;s cards. An{" "}
              <b>invalid move is simply refused and does not count</b> — it can
              never advance your board or your progress. The server owns the
              deal, the clock, the progress and the winner: it validates every
              move, and it is the only thing that ever decides the result.
            </>
          ),
        },
        {
          heading: "No stakes, pure skill",
          body: (
            <>
              There are <b>no wagers, no betting, no tokens and no payouts</b>{" "}
              in Solitaire Duel. Ranked matches move your rating and trophies,
              and nothing else — the outcome turns only on how fast and how
              accurately you solve the same puzzle your opponent is looking at.
            </>
          ),
        },
      ],
    }),
    [],
  );

  return (
    <PvpLobbyPage
      title="Solitaire Duel"
      subtitle="A rated 1v1 Solitaire race. Both players receive the exact same Klondike deal and play it simultaneously — solve the whole puzzle first, or lead on progress when the clock runs out."
      icon={
        <IconCards className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />
      }
      rules={rules}
      rulesKey="solitaire-duel"
      waitingSubtitle="Pairing you with another Solitaire Duel player…"
      busy={busy}
      onPlay={createOrJoin}
      playLabel="Find a Match"
      playBusyLabel="Searching…"
      canPlay={Boolean(isSignedIn)}
      children={
        <AiDifficultyPicker
          gameKey="solitaire-duel"
          value={aiDifficulty}
          onChange={setAiDifficulty}
          hint={{
            easy: "A slow, sloppy solver — beatable by anyone who plays carefully.",
            normal: "A steady solver of the same deal. Beat it with a clean run.",
            hard: "A fast, near-optimal solver of the shared deal.",
          }}
        />
      }
      extraActions={
        <button
          type="button"
          onClick={playAi}
          disabled={busy}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-400/10 py-2 text-sm font-bold text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-50"
        >
          Play Free vs AI
        </button>
      }
      lobbies={[]}
      error={error}
    />
  );
}
