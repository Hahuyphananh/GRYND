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
        // The proxy rejects POSTs without a JSON content-type (415), even
        // bodyless ones — declare it so matchmaking reaches the route.
        headers: { "Content-Type": "application/json" },
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

  // Speed Typing is unstaked — stakes are retired platform-wide and this game
  // never had one — so there is no wager picker, no balance and no escrow note
  // anywhere on this screen.
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
              typing. There are <b>no wagers, no tokens and no payouts</b> —
              ranked Speed Typing moves your rating and trophies, nothing else.
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
      waitingSubtitle="Pairing you with another Speed Typing player…"
      busy={busy}
      onPlay={createOrJoin}
      playLabel="Find a Match"
      playBusyLabel="Searching…"
      canPlay={Boolean(isSignedIn)}
      children={
        <AiDifficultyPicker
          gameKey="speed-typing"
          value={aiDifficulty}
          onChange={setAiDifficulty}
          hint={{
            easy: "A slower typist that makes plenty of mistakes — a comfortable win.",
            normal: "A solid amateur pace. Beat it with quick, accurate typing.",
            hard: "A fast, near-flawless typist. Only a genuinely quick run beats it.",
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
