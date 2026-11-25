"use client";

// src/components/play/PuzzleAiLobby.tsx
//
// THE PUZZLE vs AI LOBBY — the same six Solitaire opponents, practice only.
//
//   GET  /api/solitaire-puzzle/ai/bots            the shared public roster
//   POST /api/solitaire-puzzle/ai                 start a practice session
//   then the live board (PuzzleSessionPlayer) polls
//   GET  /api/solitaire-puzzle/session/<id>       the bot's live progress
//
// The picker is NOT a new roster: it renders `publicSolitaireBots()` from the
// duel bot module, so the names, descriptions, difficulty labels and avatars
// are the existing identities. The opponent is always labelled as AI, and the
// lobby note states that practice awards nothing.
//
// Once a session starts the picker gives way to the SAME interactive puzzle
// board Puzzle Ranked uses: drag/click a card, and the server judges the move.
//
// REFRESH: the active practice session id is kept in this tab's sessionStorage
// and re-validated against the server before it is restored. Practice is
// untimed, so a reload resumes the same robot race instead of opening a second
// session. A finished session is restored too, so the result survives F5. If
// the server no longer knows the row, the pointer is dropped and the picker
// returns instead of showing a dead board.

import { useCallback, useEffect, useState } from "react";

import BotAvatar from "../solitaire-duel/BotAvatar";
import ModeLobby from "./ModeLobby";
import PuzzleSessionPlayer from "./PuzzleSessionPlayer";
import { useTranslation } from "../../hooks/useTranslation";

type PublicBot = {
  id: string;
  name: string;
  rating: number | null;
  ratingLabel: string;
  difficulty: string;
  difficultyLabel: string;
  description: string;
  initials: string;
  avatar: { src: string | null; alt: string };
  order: number;
};

type Level = { level: number; id: string; key: string };

/** One tab's active practice pointer. Not a cache of any match data. */
const PUZZLE_AI_SESSION_KEY = "grynd:solitaire-puzzle:ai-session:v1";

type StoredSession = {
  sessionId: string;
  botId: string;
  botName: string | null;
};

function readStoredSession(): StoredSession | null {
  try {
    const raw = window.sessionStorage.getItem(PUZZLE_AI_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession> | null;
    if (typeof parsed?.sessionId !== "string" || typeof parsed?.botId !== "string") {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      botId: parsed.botId,
      botName: typeof parsed.botName === "string" ? parsed.botName : null,
    };
  } catch {
    return null;
  }
}

function storeSession(value: StoredSession): void {
  try {
    window.sessionStorage.setItem(PUZZLE_AI_SESSION_KEY, JSON.stringify(value));
  } catch {
    // Private mode / storage disabled: the current page still plays; only the
    // reload resume is lost.
  }
}

function clearStoredSession(): void {
  try {
    window.sessionStorage.removeItem(PUZZLE_AI_SESSION_KEY);
  } catch {
    // Nothing to clear.
  }
}

export default function PuzzleAiLobby() {
  const { t } = useTranslation();
  const [bots, setBots] = useState<PublicBot[]>([]);
  const [levels, setLevels] = useState<Level[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [botId, setBotId] = useState<string | null>(null);
  const [level, setLevel] = useState<string>("all");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [restoredBotName, setRestoredBotName] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/solitaire-puzzle/ai/bots", { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.success) {
          if (!cancelled) setLoadError(true);
          return;
        }
        if (cancelled) return;
        setBots((body.data?.bots ?? []) as PublicBot[]);
        setLevels((body.data?.levels ?? []) as Level[]);
        setLoadError(false);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-validate the tab's saved session with the server BEFORE showing it, so
  // a deleted/expired row cannot produce a board that never loads.
  useEffect(() => {
    let cancelled = false;
    const stored = readStoredSession();
    if (!stored) {
      setRestoring(false);
      return;
    }

    (async () => {
      try {
        const res = await fetch(
          `/api/solitaire-puzzle/session/${stored.sessionId}`,
          { cache: "no-store" },
        );
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !body?.success || body?.data?.mode !== "ai") {
          clearStoredSession();
          return;
        }
        setBotId(stored.botId);
        setRestoredBotName(stored.botName);
        setSessionId(stored.sessionId);
      } catch {
        // A network blip must not delete the pointer: the player can reload.
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(async () => {
    if (!botId || starting) return;
    setStarting(true);
    setStartError(false);
    try {
      const res = await fetch("/api/solitaire-puzzle/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botId,
          level: level === "all" ? null : Number(level),
          puzzleCount: 1,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success || !body?.data?.sessionId) {
        setStartError(true);
        return;
      }
      const nextId = String(body.data.sessionId);
      const botName = bots.find((bot) => bot.id === botId)?.name ?? null;
      setRestoredBotName(botName);
      setSessionId(nextId);
      storeSession({ sessionId: nextId, botId, botName });
    } catch {
      setStartError(true);
    } finally {
      setStarting(false);
    }
  }, [botId, level, starting, bots]);

  const reset = () => {
    clearStoredSession();
    setSessionId(null);
    setRestoredBotName(null);
    setStartError(false);
  };

  const selectedBot = bots.find((bot) => bot.id === botId) ?? null;
  const opponentName = selectedBot?.name ?? restoredBotName;

  // A started session is the board, at full width: the lobby chrome would only
  // squeeze the seven tableau columns.
  if (sessionId) {
    return (
      <PuzzleSessionPlayer
        sessionId={sessionId}
        mode="ai"
        opponentName={opponentName}
        onRestart={start}
        onChooseBot={reset}
      />
    );
  }

  const action = (
    <button
      type="button"
      onClick={start}
      disabled={!botId || starting || restoring}
      data-testid="puzzle-ai-start"
      className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[#c4b5fd] px-5 py-2.5 text-sm font-black text-[#12081f] transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {starting ? t("playHub.lobby.puzzleAi.starting") : t("playHub.lobby.puzzleAi.start")}
    </button>
  );

  return (
    <ModeLobby mode="puzzleAi" action={action}>
      <div className="space-y-4">
        {restoring && (
          <p role="status" className="text-xs text-white/50">
            {t("playHub.lobby.puzzleAi.restoring")}
          </p>
        )}

        {loadError ? (
          <p role="alert" className="text-xs text-rose-200">
            {t("playHub.lobby.puzzleAi.loadError")}
          </p>
        ) : bots.length === 0 ? (
          <p className="text-xs text-white/50">{t("playHub.lobby.puzzleAi.loading")}</p>
        ) : (
          <>
            {selectedBot && (
              <div className="flex items-center gap-3 rounded-xl border border-[#c4b5fd]/30 bg-[#c4b5fd]/8 p-3">
                <BotAvatar
                  bot={selectedBot}
                  size="h-12 w-12"
                  perfect={selectedBot.id === "perfect"}
                />
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-black text-white">
                    {selectedBot.name}
                    <span className="rounded-full border border-[#c4b5fd]/40 bg-[#c4b5fd]/10 px-2 py-0.5 text-[11px] font-black uppercase tracking-[0.14em] text-[#ddd6fe]">
                      {t("playHub.lobby.puzzleAi.aiBadge")}
                    </span>
                  </p>
                  <p className="text-[11px] text-white/50">{selectedBot.difficultyLabel}</p>
                </div>
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              {bots.map((bot) => (
                <button
                  key={bot.id}
                  type="button"
                  onClick={() => setBotId(bot.id)}
                  aria-pressed={botId === bot.id}
                  data-testid={`puzzle-ai-bot-${bot.id}`}
                  className={`flex items-center gap-3 rounded-xl border p-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c4b5fd] motion-reduce:transition-none ${
                    botId === bot.id
                      ? "border-[#c4b5fd]/70 bg-[#c4b5fd]/12"
                      : "border-white/10 bg-white/[0.03] hover:border-white/25"
                  }`}
                >
                  <BotAvatar bot={bot} size="h-11 w-11" perfect={bot.id === "perfect"} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-black text-white">
                      {bot.name}
                    </span>
                    <span className="block truncate text-[11px] uppercase tracking-[0.12em] text-white/45">
                      {bot.difficultyLabel}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label
                htmlFor="puzzle-ai-level"
                className="text-[11px] font-black uppercase tracking-[0.16em] text-white/50"
              >
                {t("playHub.lobby.puzzleAi.level")}
              </label>
              <select
                id="puzzle-ai-level"
                value={level}
                onChange={(event) => setLevel(event.target.value)}
                className="min-h-9 rounded-lg border border-white/15 bg-black/40 px-2 text-xs text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c4b5fd]"
              >
                <option value="all">{t("playHub.lobby.puzzleAi.anyLevel")}</option>
                {levels.map((entry) => (
                  <option key={entry.level} value={String(entry.level)}>
                    {entry.level} · {t(entry.key)}
                  </option>
                ))}
              </select>
            </div>

            {startError && (
              <p role="alert" className="text-xs text-rose-200">
                {t("playHub.lobby.puzzleAi.startError")}
              </p>
            )}
          </>
        )}
      </div>
    </ModeLobby>
  );
}
