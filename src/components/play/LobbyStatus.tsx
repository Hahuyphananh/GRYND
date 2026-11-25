"use client";

// src/components/play/LobbyStatus.tsx
//
// Real status for the Solo, Daily Challenge, Daily Puzzle and Unlimited Puzzle
// lobbies. Every figure comes from an existing server endpoint:
//
//   /api/solitaire/solo       — the player's own solo record
//   /api/solitaire/daily      — today's daily result and streak
//   /api/solitaire/puzzle     — the puzzle already answered (if any) and the
//                               server-authoritative allowance
//
// A failed or empty response renders an honest empty state. No number is
// fabricated, and the puzzle lobby never consumes an attempt: GET is read-only.

import { useEffect, useState } from "react";
import Link from "next/link";

import { useTranslation } from "../../hooks/useTranslation";

type Payload = { data?: Record<string, unknown> | null } | null;

type SoloSummary = {
  games?: number;
  completed?: number;
  completionRate?: number | null;
  bestMs?: number | null;
  averageMs?: number | null;
};

type DailySummary = {
  completed?: number;
  currentStreak?: number;
  longestStreak?: number;
  bestMs?: number | null;
  today?: {
    completed?: boolean;
    moves?: number;
    elapsedMs?: number | null;
  } | null;
};

type PuzzleStatus = {
  dateKey?: string | null;
  board?: { tableau?: unknown[]; stockCount?: number } | null;
  attempt?: { move?: unknown; correct?: boolean } | null;
  answerMove?: unknown;
  step?: number;
  totalSteps?: number;
  status?: "playing" | "failed" | "completed";
  allowance?: {
    unlimited?: boolean;
    limit?: number | null;
    used?: number;
    remaining?: number | null;
    resetsAt?: string;
  } | null;
};

/**
 * A move in plain words, for the lobby summary. Deliberately local and tiny:
 * the lobby only needs to NAME the winning move, and pulling the puzzle's
 * feedback module into the hub would ship its copy twice.
 */
const RANK_TEXT = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUIT_TEXT: Record<string, string> = {
  spades: "\u2660",
  hearts: "\u2665",
  diamonds: "\u2666",
  clubs: "\u2663",
};

function moveLabel(move: unknown): string | null {
  if (!move || typeof move !== "object") return null;
  const value = move as {
    kind?: string;
    card?: { suit?: string; rank?: number } | null;
    fromColumn?: number;
    toColumn?: number;
    suit?: string;
  };
  const card = value.card
    ? `${RANK_TEXT[value.card.rank ?? 0] ?? ""}${SUIT_TEXT[value.card.suit ?? ""] ?? ""}`
    : "the card";
  switch (value.kind) {
    case "tableau-to-tableau":
      return `${card} from column ${(value.fromColumn ?? 0) + 1} onto column ${(value.toColumn ?? 0) + 1}`;
    case "tableau-to-foundation":
      return `${card} from column ${(value.fromColumn ?? 0) + 1} to the ${value.suit} foundation`;
    case "waste-to-tableau":
      return `the waste card onto column ${(value.toColumn ?? 0) + 1}`;
    case "waste-to-foundation":
      return `the waste card to the ${value.suit} foundation`;
    case "foundation-to-tableau":
      return `a foundation card back down onto column ${(value.toColumn ?? 0) + 1}`;
    case "draw":
      return "draw from the stock";
    default:
      return null;
  }
}

function formatDuration(ms: number | null | undefined): string {
  if (!Number.isFinite(ms) || (ms as number) <= 0) return "—";
  const total = Math.floor((ms as number) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function useStatus(url: string) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch(url, { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as Payload;
        if (cancelled) return;
        if (!response.ok || !body?.data) {
          setState("error");
          return;
        }
        setData(body.data);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return { data, state };
}

function Loading({ label }: { label: string }) {
  return <p className="text-sm font-semibold text-white/45">{label}</p>;
}

function Failed({ label, retry }: { label: string; retry: string }) {
  return (
    <p className="rounded-xl border border-[#f5ff3b]/20 bg-[#f5ff3b]/[0.05] px-3 py-2 text-xs font-semibold text-[#ffe9a3]">
      {label} <button type="button" onClick={() => window.location.reload()} className="underline">{retry}</button>
    </p>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-1.5">
      <span className="text-[11px] font-semibold text-white/50">{label}</span>
      <span className="font-mono text-sm font-bold text-white">{value}</span>
    </div>
  );
}

export default function LobbyStatus({
  mode,
}: {
  mode: "solo" | "daily" | "dailyPuzzle" | "unlimited";
}) {
  const { t } = useTranslation();
  const endpoint =
    mode === "solo"
      ? "/api/solitaire/solo"
      : mode === "daily"
        ? "/api/solitaire/daily"
        : mode === "dailyPuzzle"
          ? "/api/solitaire/puzzle?kind=daily"
          : // The unlimited lobby only prints the count, so it asks for the
            // allowance alone instead of making the server build a position.
            "/api/solitaire/puzzle?kind=unlimited&allowanceOnly=1";
  const { data, state } = useStatus(endpoint);

  if (state === "loading") return <Loading label={t("playHub.loading")} />;
  if (state === "error" || !data) {
    return <Failed label={t("playHub.unavailable")} retry={t("playHub.retry")} />;
  }

  if (mode === "solo") {
    const summary = (data.summary ?? null) as SoloSummary | null;
    if (!summary || !summary.games) {
      return <p className="text-sm leading-relaxed text-white/50">{t("playHub.lobby.solo.empty")}</p>;
    }
    return (
      <div className="grid gap-1.5 sm:grid-cols-2">
        <Row label={t("playHub.lobby.solo.statsGames")} value={String(summary.games ?? 0)} />
        <Row label={t("playHub.lobby.solo.statsCompleted")} value={String(summary.completed ?? 0)} />
        <Row
          label={t("playHub.lobby.solo.statsRate")}
          value={summary.completionRate == null ? "—" : `${summary.completionRate}%`}
        />
        <Row label={t("playHub.lobby.solo.statsBest")} value={formatDuration(summary.bestMs)} />
        <Row label={t("playHub.lobby.solo.statsAverage")} value={formatDuration(summary.averageMs)} />
        <p className="text-[10px] leading-relaxed text-white/35 sm:col-span-2">
          {t("playHub.lobby.solo.guest")}
        </p>
      </div>
    );
  }

  if (mode === "daily") {
    const summary = (data.summary ?? null) as DailySummary | null;
    const today = summary?.today ?? null;
    const statusLabel = !today
      ? t("playHub.lobby.daily.notStarted")
      : today.completed
        ? t("playHub.lobby.daily.completed")
        : t("playHub.lobby.daily.inProgress");
    return (
      <div className="grid gap-1.5 sm:grid-cols-2">
        <Row label={t("playHub.statusTitle")} value={statusLabel} />
        <Row label={t("playHub.lobby.daily.streak")} value={String(summary?.currentStreak ?? 0)} />
        <Row label={t("playHub.lobby.daily.longest")} value={String(summary?.longestStreak ?? 0)} />
        <Row label={t("playHub.lobby.daily.best")} value={formatDuration(summary?.bestMs)} />
        <p className="text-[10px] leading-relaxed text-white/35 sm:col-span-2">
          {t("playHub.lobby.daily.guest")}
        </p>
      </div>
    );
  }

  const puzzle = data as unknown as PuzzleStatus;
  if (mode === "dailyPuzzle") {
    const attempt = puzzle.attempt ?? null;
    const status = puzzle.status ?? "playing";
    const step = puzzle.step ?? 1;
    const total = puzzle.totalSteps ?? 3;
    const statusLabel =
      status === "completed"
        ? t("playHub.lobby.dailyPuzzle.completed")
        : status === "failed"
          ? t("playHub.lobby.dailyPuzzle.failed")
          : step > 1
            ? t("playHub.lobby.dailyPuzzle.inProgress")
            : t("playHub.lobby.dailyPuzzle.available");
    return (
      <div className="space-y-1.5">
        <Row label={t("playHub.statusTitle")} value={statusLabel} />
        <Row
          label={t("playHub.lobby.dailyPuzzle.progress")}
          value={t("playHub.lobby.dailyPuzzle.stepProgress", { step, total })}
        />
        {attempt && (
          <Row
            label={t("playHub.lobby.dailyPuzzle.stepResult")}
            value={
              attempt.correct
                ? t("playHub.lobby.dailyPuzzle.correct")
                : t("playHub.lobby.dailyPuzzle.incorrect")
            }
          />
        )}
        {attempt && puzzle.answerMove && moveLabel(puzzle.answerMove) && (
          <p className="rounded-xl border border-[#00ffa3]/20 bg-[#00ffa3]/[0.06] px-3 py-2 text-xs leading-relaxed text-[#c8ffe6]">
            {t("playHub.lobby.dailyPuzzle.answer", {
              answer: moveLabel(puzzle.answerMove) as string,
            })}{" "}
            {t("playHub.lobby.dailyPuzzle.explanation")}
          </p>
        )}
        <p className="text-[10px] leading-relaxed text-white/35">
          {t("playHub.lobby.dailyPuzzle.resets")}{" "}
          {t("playHub.lobby.dailyPuzzle.guest")}
        </p>
      </div>
    );
  }

  // Unlimited puzzles: a single best move per puzzle, 5 free per UTC day.
  const allowance = puzzle.allowance ?? null;
  if (!allowance) {
    return <p className="text-sm text-white/50">{t("playHub.unavailable")}</p>;
  }
  if (allowance.unlimited) {
    return (
      <div className="space-y-1.5">
        <Row
          label={t("playHub.statusTitle")}
          value={t("playHub.lobby.unlimited.unlimited")}
        />
        <p className="text-[10px] leading-relaxed text-white/35">
          {t("playHub.lobby.unlimited.oneType")}
        </p>
      </div>
    );
  }

  const remaining = allowance.remaining ?? 0;
  const limit = allowance.limit ?? 5;
  return (
    <div className="space-y-1.5">
      <Row
        label={t("playHub.statusTitle")}
        value={t("playHub.lobby.unlimited.remaining", { remaining, limit })}
      />
      <Row
        label={t("playHub.lobby.unlimited.used", { used: allowance.used ?? 0 })}
        value={`${allowance.used ?? 0}/${limit}`}
      />
      <p className="text-[10px] leading-relaxed text-white/35">
        {t("playHub.lobby.unlimited.oneType")} {t("playHub.lobby.unlimited.reset")}
      </p>
      {remaining === 0 && (
        <p className="rounded-xl border border-[#f5ff3b]/25 bg-[#f5ff3b]/[0.06] px-3 py-2 text-xs font-semibold text-[#ffe9a3]">
          {t("playHub.lobby.unlimited.freeNote")}{" "}
          <Link href="/upgrade-pro" className="underline">
            {t("playHub.upgrade")}
          </Link>
        </p>
      )}
    </div>
  );
}
