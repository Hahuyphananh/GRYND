"use client";

// src/hooks/useSolitaireBotDialogue.ts
//
// The practice match's one dialogue entry point. It owns a per-match director,
// feeds it only ADOPTED snapshots, and exposes at most one presentation-safe
// line. The page passes the already-adopted `match` (the same object the board
// renders) plus the paused flag, and resolves `line.key` through
// `useTranslation()` in `BotSpeech` — in the opponent strip while racing and in
// the shared result screen once the match ends.
//
// Why a signature: the page re-renders on every clock tick and re-adopts the
// same snapshot on every poll. Keying the effect on the match identity would
// re-observe unchanged reads; keying it on the fields detection can see means
// only a real change is processed. The director then deduplicates anyway.

import { useEffect, useRef, useState } from "react";
import { createDialogueDirector } from "../lib/solitaire-duel/dialogueDirector";
import type {
  DialogueDirector,
  SolitaireBotDialogueLine,
} from "../lib/solitaire-duel/dialogueDirector";
import type { SolitaireDialogueSnapshot } from "../lib/solitaire-duel/dialogueEvents";

export type UseSolitaireBotDialogueOptions = {
  /** Practice pause must silence ordinary progress dialogue. */
  paused?: boolean;
  /** Set false to observe without ever showing a line. */
  enabled?: boolean;
};

function snapshotSignature(
  snapshot: SolitaireDialogueSnapshot | null,
): string {
  if (!snapshot) return "none";
  return [
    snapshot.matchId,
    snapshot.botId,
    snapshot.status,
    snapshot.result,
    snapshot.seat,
    snapshot.view?.ply,
    snapshot.view?.resetCount,
    snapshot.progress?.foundationCards,
    snapshot.progress?.revealedTableau,
    snapshot.opponent?.foundationCards,
    snapshot.opponent?.revealedTableau,
    snapshot.opponent?.completed,
    snapshot.serverNow,
    snapshot.goAtMs,
  ].join("|");
}

export function useSolitaireBotDialogue(
  match: SolitaireDialogueSnapshot | null,
  options: UseSolitaireBotDialogueOptions = {},
): SolitaireBotDialogueLine | null {
  const [line, setLine] = useState<SolitaireBotDialogueLine | null>(null);
  const directorRef = useRef<DialogueDirector | null>(null);
  const previousRef = useRef<SolitaireDialogueSnapshot | null>(null);
  const matchIdRef = useRef<string | null>(null);
  const matchRef = useRef(match);
  matchRef.current = match;

  const paused = Boolean(options.paused);
  const enabled = options.enabled !== false;
  const signature = snapshotSignature(match);

  useEffect(() => {
    const snapshot = matchRef.current;
    if (!snapshot) {
      previousRef.current = null;
      setLine(null);
      return;
    }

    if (matchIdRef.current !== snapshot.matchId) {
      matchIdRef.current = snapshot.matchId;
      directorRef.current = createDialogueDirector();
      previousRef.current = null;
      setLine(null);
    }

    if (!enabled) {
      previousRef.current = snapshot;
      return;
    }

    const director =
      directorRef.current ?? (directorRef.current = createDialogueDirector());
    const previous = previousRef.current;
    previousRef.current = snapshot;

    const nextLine = director.observe(previous, snapshot, {
      paused,
      nowMs: snapshot.serverNow,
    });
    if (nextLine) setLine(nextLine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, paused, enabled]);

  // Ordinary lines are transient and never block the board. MATCH-ENDING lines
  // stay for the life of the result: the shared result screen rerenders as
  // numbers and details arrive, and the opponent must not vanish mid-sentence.
  // The next match id resets the hook, so a terminal line can never leak into
  // another deal.
  useEffect(() => {
    if (!line) return undefined;
    if (line.event === "win" || line.event === "loss") return undefined;
    const id = window.setTimeout(() => setLine(null), line.durationMs);
    return () => window.clearTimeout(id);
  }, [line]);

  return line;
}

export default useSolitaireBotDialogue;
