"use client";

// src/app/casino/speed-typing/PageClient.tsx
//
// Speed Typing lobby.
//
// FOUNDATION RELEASE. The page reuses the shared casino lobby chrome
// (`PvpLobbyPage`) — the same component every other 1v1 game mounts — so the
// page, its rules modal, its navigation bar, its footer and its platform Quick
// Queue panel are the EXISTING ones, not a new lobby system.
//
// What works today:
//   * POST /api/speed-typing/create-or-join — the one shared matchmaking path:
//     the store's `createOrJoin` (per-game advisory lock + FOR UPDATE) either
//     joins the oldest open lobby or opens one. This is the SAME function the
//     platform quick-queue worker calls as its Speed Typing destination, so the
//     two entry points can never produce different pairings.
//
// Where a pairing lands: `../[matchId]/PageClient` — the typing arena itself.
// It waits for the opponent, counts down from the server's GO instant, renders
// the shared passage with the player's live position, streams the opponent's
// server-derived progress, and hands off to the shared `PvpResultScreen` with
// the SNAPSHOT's verdict. Nothing on either screen decides a result.

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { IconKeyboardShow } from "@tabler/icons-react";
import PvpLobbyPage from "../../../components/lobby/PvpLobby";
import AiDifficultyPicker from "../../../components/lobby/AiDifficultyPicker";
import {
  type AiDifficulty,
  readStoredAiDifficulty,
} from "../../../lib/aiDifficulty";

export default function SpeedTypingLobbyPage() {
  const { isSignedIn } = useUser();
  const router = useRouter();

  // Coin wager: the player picks the stake the lobby opens at, and the server
  // escrows BOTH seats when an opponent joins. vs-AI practice stays free.
  const [stake, setStake] = useState<number>(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("speed-typing"),
  );

  const createOrJoin = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/speed-typing/create-or-join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Both seats are escrowed at this stake the moment an opponent joins.
        body: JSON.stringify({ stake }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to find a match");
        return;
      }
      router.push(`/casino/speed-typing/${data.data.matchId}`);
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
      const res = await fetch("/api/speed-typing/create-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ difficulty: aiDifficulty }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "Unable to start the practice race");
        return;
      }
      router.push(`/casino/speed-typing/${data.data.matchId}`);
    } catch {
      setError("Unable to start the practice race");
    } finally {
      setBusy(false);
    }
  }, [aiDifficulty, busy, router]);

  // PvP is a coin race: the player picks the stake above, both seats are
  // escrowed when the opponent joins, and the winner takes 1.8× (the house
  // keeps 10%). Practice against the bot stays free.
  const rules = useMemo(
    () => ({
      title: "How to Play Speed Typing",
      sections: [
        {
          heading: "Same text, fastest fingers",
          body: (
            <>
              Both players receive the <b>exact same passage</b>. Type it as
              quickly and as accurately as you can — the{" "}
              <b>first player to complete it correctly wins</b> the match.
            </>
          ),
        },
        {
          heading: "Speed and accuracy both count",
          body: (
            <>
              A real-time race, scored by the server: words per minute and
              accuracy are measured from the same clock for both seats. Neither
              player ever sees the other&apos;s keystrokes — only their progress.
            </>
          ),
        },
        {
          heading: "No randomness, no stakes",
          body: (
            <>
              Nothing is drawn during play: the outcome is entirely down to your
              typing. PvP is played for coins — both seats stake the amount you
              pick and the winner takes <b>1.8×</b> — while practice vs the bot
              is free.
            </>
          ),
        },
        {
          heading: "Rated 1v1",
          body: (
            <>
              Every completed match feeds the platform&apos;s shared per-game
              rating and trophy system, exactly like the other ranked duels. A
              practice mode against the bot is not rated.
            </>
          ),
        },
      ],
    }),
    [],
  );

  return (
    <PvpLobbyPage
      title="Speed Typing"
      subtitle="A rated 1v1 typing race. Both players get the exact same passage — type it faster and more accurately than your opponent and finish it first to take the match."
      icon={
        <IconKeyboardShow className="h-9 w-9 flex-shrink-0 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.6)] sm:h-10 sm:w-10" />
      }
      rules={rules}
      rulesKey="speed-typing"
      wager={{ value: stake, onChange: setStake }}
      waitingSubtitle={`Pairing you at ${stake} coins — both stakes are escrowed on match-up.`}
      busy={busy}
      onPlay={createOrJoin}
      playLabel="Find a Match"
      playBusyLabel="Searching…"
      canPlay={Boolean(isSignedIn) && stake >= 1}
      children={
        <AiDifficultyPicker
          gameKey="speed-typing"
          value={aiDifficulty}
          onChange={setAiDifficulty}
          hint={{
            easy: "A much slower typist — a comfortable win.",
            normal: "A solid amateur pace. Beat it with quick, accurate typing.",
            hard: "A fast, flawless typist. Only a genuinely quick run beats it.",
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
