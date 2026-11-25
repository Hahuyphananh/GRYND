"use client";

// src/components/solitaire-duel/MatchTimeline.tsx
//
// POST-MATCH "MISTAKE FINDER" — the replay scrubber that sits on the result
// screen of every duel whose server keeps a judged move log.
//
// Two states, both server-decided:
//
//   FREE — the final score and basic stats (moves, best progress, finish time).
//          The timeline itself is a GRYND PRO feature, so the panel says exactly
//          that and links to the upgrade page. It never renders a blurred or
//          partial timeline: free players get real data, not a tease dressed
//          as one.
//
//   PRO  — an interactive scrubber over every stored move from both seats, with
//          the markers the server derived (wasted moves, time-loss spikes,
//          lead changes) as jump targets, a BOARD PREVIEW that follows the
//          cursor, and a link to the full match review.
//
// The numbers are the server's; this component only chooses WHICH event is on
// screen and draws the preview from the payload the server sent (the public
// clue grid for Sudoku, the viewer's own deal and log for Solitaire).
//
// It mounts inside PvpResultScreen's `extraContent`, so it cannot appear before
// the match is over. It claims nothing about rewards and computes nothing about
// the result.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconChevronLeft,
  IconChevronRight,
  IconClockExclamation,
  IconFlag,
  IconLock,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrendingUp,
} from "@tabler/icons-react";
import { reconstructReviewPosition } from "../../lib/solitaire-duel/reviewView";

type GameKey = "solitaire-duel" | "sudoku-duel";
type MarkerKind = "lead-change" | "wasted-move" | "time-loss";

type TimelineEvent = {
  index: number;
  atMs: number;
  seat: "player1" | "player2";
  label: string;
  ply: number;
  kind: string;
  progressAfter: number;
  gapMs: number | null;
  rating: string | null;
  wasted: boolean;
  moveLabel: string;
};

type TimelineMarker = {
  kind: MarkerKind;
  index: number;
  atMs: number;
  seat: "player1" | "player2";
  ply: number;
  label: string;
};

type Basic = {
  durationMs: number | null;
  yourSeat: "player1" | "player2";
  moves: { you: number; opponent: number };
  peakProgress: { you: number; opponent: number };
  finishedAtMs: { you: number | null; opponent: number | null };
};

type Preview =
  | {
      game: "solitaire";
      deal: unknown;
      moves: { kind: string; move: unknown }[];
    }
  | {
      game: "sudoku";
      puzzle: number[];
      moves: {
        ply: number;
        kind: string;
        index: number;
        value: number | null;
        correct: boolean;
      }[];
    };

type TimelinePayload = {
  pro: boolean;
  locked: boolean;
  gameKey?: GameKey;
  progressLabel?: string;
  progressMax?: number;
  reviewHref?: string | null;
  basic: Basic;
  preview?: Preview;
  timeline?: {
    durationMs: number | null;
    progressMax: number;
    events: TimelineEvent[];
    markers: TimelineMarker[];
    summary: {
      turningPoints: number;
      wastedMoves: number;
      timeLossSpikes: number;
    };
  };
};

const MARKER_META: Record<
  MarkerKind,
  { label: string; icon: typeof IconFlag; chip: string }
> = {
  "lead-change": {
    label: "Lead change",
    icon: IconTrendingUp,
    chip: "border-[#00e5ff]/40 bg-[#00e5ff]/10 text-[#9be9ff]",
  },
  "wasted-move": {
    label: "Wasted move",
    icon: IconAlertTriangle,
    chip: "border-rose-400/40 bg-rose-400/10 text-rose-200",
  },
  "time-loss": {
    label: "Time-loss spike",
    icon: IconClockExclamation,
    chip: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  },
};

const RANK_LABELS: Record<number, string> = { 1: "A", 11: "J", 12: "Q", 13: "K" };
const SUIT_GLYPHS: Record<string, string> = {
  spades: "\u2660",
  hearts: "\u2665",
  diamonds: "\u2666",
  clubs: "\u2663",
};

function formatClock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "—";
  const total = Math.max(0, Math.round(Number(ms) / 100) / 10);
  const minutes = Math.floor(total / 60);
  const seconds = Math.round((total - minutes * 60) * 10) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function formatPause(ms: number | null): string {
  if (ms === null) return "first move";
  return `${Math.round(ms / 100) / 10}s`;
}

export default function MatchTimeline({
  matchId,
  gameKey = "solitaire-duel",
}: {
  matchId: string;
  gameKey?: GameKey;
}) {
  const [data, setData] = useState<TimelinePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const endpoint = gameKey === "sudoku-duel" ? "sudoku-duel" : "solitaire-duel";

  useEffect(() => {
    if (!matchId) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/${endpoint}/match/${encodeURIComponent(matchId)}/timeline`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((res) => res.json().catch(() => null))
      .then((body) => {
        if (controller.signal.aborted) return;
        if (!body?.success || !body?.data) {
          setError("The timeline for this match is unavailable.");
          setData(null);
          return;
        }
        setData(body.data as TimelinePayload);
        setCursor(0);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("The timeline could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [matchId, endpoint]);

  const events = data?.timeline?.events ?? [];

  useEffect(() => {
    if (!playing) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return undefined;
    }
    timerRef.current = setInterval(() => {
      setCursor((current) => {
        if (current >= events.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 600);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [playing, events.length]);

  const selected = events[Math.min(cursor, Math.max(0, events.length - 1))] ?? null;

  // Progress per seat AS OF the cursor, derived from the ordered events the
  // server sent — no replay, no hidden board.
  const progress = useMemo(() => {
    const result = { player1: 0, player2: 0 };
    for (const event of events) {
      if (event.index > cursor) break;
      result[event.seat] = event.progressAfter;
    }
    return result;
  }, [events, cursor]);

  // The viewer's own ply at the cursor: the preview shows the board after that
  // many of THEIR moves, not the global event count.
  const viewerPly = useMemo(() => {
    if (!data) return 0;
    const yourSeat = data.basic.yourSeat;
    return events.filter((event) => event.index <= cursor && event.seat === yourSeat).length;
  }, [events, cursor, data]);

  if (!matchId) return null;

  if (loading) {
    return (
      <div
        className="mt-4 animate-pulse rounded-xl border border-white/10 bg-white/[0.03] px-3 py-4 text-xs text-white/40"
        data-testid="match-timeline-loading"
      >
        Loading match timeline…
      </div>
    );
  }

  if (error || !data) {
    return error ? (
      <p className="mt-4 text-[11px] text-white/40" data-testid="match-timeline-error">
        {error}
      </p>
    ) : null;
  }

  const basic = data.basic;
  const isPro = Boolean(data.pro && data.timeline);
  const progressLabel = data.progressLabel ?? "foundation cards";
  const progressMax = data.timeline?.progressMax ?? data.progressMax ?? 52;

  return (
    <div
      className="mt-4 rounded-xl border border-[#00e5ff]/30 bg-surface/80 p-3 text-left"
      data-testid="match-timeline"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-black uppercase tracking-wider text-[#00e5ff]">
          Mistake Finder
        </p>
        <span
          className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
            isPro
              ? "border-[#f5ff3b]/50 bg-[#f5ff3b]/10 text-[#f5ff3b]"
              : "border-white/15 bg-white/5 text-white/50"
          }`}
        >
          {isPro ? "PRO" : "Basic stats"}
        </span>
      </div>

      {/* Basic stats — free for everyone, from the settled match row. */}
      <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px]">
        <Stat label="Your moves" value={String(basic.moves.you)} />
        <Stat label="Opponent moves" value={String(basic.moves.opponent)} />
        <Stat
          label={`Your best ${progressLabel}`}
          value={`${basic.peakProgress.you}/${progressMax}`}
        />
        <Stat
          label={`Opponent best ${progressLabel}`}
          value={`${basic.peakProgress.opponent}/${progressMax}`}
        />
        <Stat label="Your finish" value={formatClock(basic.finishedAtMs.you)} />
        <Stat label="Match length" value={formatClock(basic.durationMs)} />
      </div>

      {!isPro ? (
        <div
          className="mt-3 rounded-lg border border-[#f5ff3b]/30 bg-[#f5ff3b]/[0.05] p-3"
          data-testid="match-timeline-locked"
        >
          <p className="flex items-center gap-1.5 text-[11px] font-black text-[#f5ff3b]">
            <IconLock size={13} aria-hidden="true" />
            Timeline &amp; replay scrubber
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-white/60">
            See every move from both seats on one timeline, with exact turning
            points, wasted moves and time-loss spikes compared with your
            opponent, and the board at any moment. Included with GRYND PRO.
          </p>
          <Link
            href="/upgrade-pro"
            className="mt-2 inline-flex items-center gap-1 text-[11px] font-black text-[#f5ff3b] underline decoration-[#f5ff3b]/40 underline-offset-2"
          >
            Unlock the timeline
            <IconArrowRight size={12} aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <SummaryChip
              kind="lead-change"
              value={data.timeline!.summary.turningPoints}
            />
            <SummaryChip
              kind="wasted-move"
              value={data.timeline!.summary.wastedMoves}
            />
            <SummaryChip kind="time-loss" value={data.timeline!.summary.timeLossSpikes} />
          </div>

          {events.length === 0 ? (
            <p className="mt-3 text-[11px] text-white/45">
              No move log was recorded for this match.
            </p>
          ) : (
            <div className="mt-3">
              <input
                type="range"
                min={0}
                max={Math.max(0, events.length - 1)}
                value={Math.min(cursor, events.length - 1)}
                onChange={(event) => {
                  setPlaying(false);
                  setCursor(Number(event.target.value));
                }}
                aria-label="Scrub the match timeline"
                data-testid="match-timeline-scrub"
                className="w-full accent-[#00e5ff]"
              />

              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPlaying(false);
                    setCursor((current) => Math.max(0, current - 1));
                  }}
                  aria-label="Previous move"
                  className="rounded-md border border-white/15 p-1.5 text-white/70 transition hover:bg-white/5"
                >
                  <IconChevronLeft size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => setPlaying((value) => !value)}
                  aria-label={playing ? "Pause replay" : "Play replay"}
                  data-testid="match-timeline-play"
                  className="rounded-md border border-[#00e5ff]/40 bg-[#00e5ff]/10 p-1.5 text-[#00e5ff] transition hover:bg-[#00e5ff]/20"
                >
                  {playing ? (
                    <IconPlayerPause size={14} aria-hidden="true" />
                  ) : (
                    <IconPlayerPlay size={14} aria-hidden="true" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPlaying(false);
                    setCursor((current) => Math.min(events.length - 1, current + 1));
                  }}
                  aria-label="Next move"
                  className="rounded-md border border-white/15 p-1.5 text-white/70 transition hover:bg-white/5"
                >
                  <IconChevronRight size={14} aria-hidden="true" />
                </button>
                <span className="ml-auto font-mono text-[10px] text-white/50">
                  {formatClock(selected?.atMs ?? 0)} · {cursor + 1}/{events.length}
                </span>
              </div>

              {selected && (
                <div className="mt-2 rounded-lg border border-white/10 bg-black/25 p-2.5">
                  <p className="text-[10px] uppercase tracking-wider text-white/45">
                    {selected.label} · move {selected.ply} · pause{" "}
                    {formatPause(selected.gapMs)}
                  </p>
                  <p className="mt-0.5 text-xs font-bold text-white/90">
                    {selected.moveLabel}
                  </p>
                  <div className="mt-1.5 space-y-1">
                    <ProgressRow
                      label={selected.label}
                      value={progress[selected.seat]}
                      max={progressMax}
                      tone="cyan"
                    />
                    <ProgressRow
                      label={selected.label === "You" ? "Opponent" : "You"}
                      value={progress[selected.seat === "player1" ? "player2" : "player1"]}
                      max={progressMax}
                      tone="muted"
                    />
                  </div>

                  {data.preview ? (
                    <BoardPreview preview={data.preview} ply={viewerPly} />
                  ) : null}
                </div>
              )}

              {data.timeline!.markers.length > 0 && (
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto pr-1">
                  {data.timeline!.markers.map((marker) => {
                    const meta = MARKER_META[marker.kind];
                    const Icon = meta.icon;
                    return (
                      <li key={`${marker.kind}-${marker.index}`}>
                        <button
                          type="button"
                          onClick={() => {
                            setPlaying(false);
                            setCursor(marker.index);
                          }}
                          data-testid="match-timeline-marker"
                          className={`flex w-full items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[10px] transition hover:brightness-125 ${meta.chip}`}
                        >
                          <Icon size={11} aria-hidden="true" />
                          <span className="font-bold">{meta.label}</span>
                          <span className="truncate text-white/55">{marker.label}</span>
                          <span className="ml-auto shrink-0 font-mono text-white/45">
                            {formatClock(marker.atMs)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {data.reviewHref ? (
            <Link
              href={data.reviewHref}
              data-testid="match-timeline-review-link"
              className="mt-3 inline-flex items-center gap-1 text-[11px] font-black text-[#00e5ff] underline decoration-[#00e5ff]/40 underline-offset-2"
            >
              Open full match review
              <IconArrowRight size={12} aria-hidden="true" />
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A compact, read-only board that follows the scrubber. */
function BoardPreview({ preview, ply }: { preview: Preview; ply: number }) {
  if (preview.game === "sudoku") return <SudokuPreview preview={preview} ply={ply} />;
  return <SolitairePreview preview={preview} ply={ply} />;
}

function SolitairePreview({
  preview,
  ply,
}: {
  preview: Extract<Preview, { game: "solitaire" }>;
  ply: number;
}) {
  const position = useMemo(
    () =>
      reconstructReviewPosition(
        preview.deal as never,
        preview.moves as never,
        Math.max(0, ply),
      ),
    [preview, ply],
  );

  if (!position.ok) {
    return (
      <p className="mt-2 text-[10px] text-white/40" data-testid="match-timeline-preview">
        Position unavailable at this move.
      </p>
    );
  }

  const state = position.state as unknown as {
    tableau: { faceUp: boolean; card: { rank: number; suit: string } | null }[][];
    foundations: Record<string, { rank: number; suit: string }[]>;
  };
  const foundations = Object.values(state.foundations ?? {}).reduce(
    (total, pile) => total + (pile?.length ?? 0),
    0,
  );
  const columns = state.tableau ?? [];

  return (
    <div className="mt-2" data-testid="match-timeline-preview" data-ply={ply}>
      <p className="text-[9px] uppercase tracking-wider text-white/40">
        Your board · move {ply}
      </p>
      <div className="mt-1 grid grid-cols-7 gap-0.5">
        {columns.map((column, index) => {
          const top = column[column.length - 1];
          const faceUp = Boolean(top?.faceUp && top.card);
          return (
            <div
              key={index}
              className="flex h-9 flex-col items-center justify-center rounded border border-white/10 bg-white/[0.04]"
            >
              <span
                className={`text-[10px] font-black leading-none ${
                  faceUp ? "text-white/85" : "text-white/25"
                }`}
              >
                {faceUp && top.card
                  ? `${RANK_LABELS[top.card.rank] ?? top.card.rank}${
                      SUIT_GLYPHS[top.card.suit] ?? ""
                    }`
                  : "\u25AE"}
              </span>
              <span className="mt-0.5 font-mono text-[8px] text-white/35">
                {column.length}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-right font-mono text-[9px] text-white/45">
        foundations {foundations}/52
      </p>
    </div>
  );
}

function SudokuPreview({
  preview,
  ply,
}: {
  preview: Extract<Preview, { game: "sudoku" }>;
  ply: number;
}) {
  const grid = useMemo(() => {
    const cells = [...preview.puzzle];
    for (const move of preview.moves) {
      if (move.ply >= ply) break;
      if (move.kind === "clear") cells[move.index] = 0;
      else if (move.correct && typeof move.value === "number") {
        cells[move.index] = move.value;
      }
    }
    return cells;
  }, [preview, ply]);

  return (
    <div
      className="mt-2"
      data-testid="match-timeline-preview"
      data-ply={ply}
    >
      <p className="text-[9px] uppercase tracking-wider text-white/40">
        Your board · move {ply}
      </p>
      <div
        className="mx-auto mt-1 grid w-[168px] grid-cols-9 gap-px rounded border border-white/15 bg-white/10 p-px"
        data-testid="match-timeline-sudoku-grid"
      >
        {grid.map((value, index) => {
          const given = Number(preview.puzzle[index]) !== 0;
          return (
            <span
              key={index}
              className={`flex aspect-square items-center justify-center bg-surface font-mono text-[9px] leading-none ${
                given
                  ? "font-black text-white/75"
                  : value
                    ? "font-bold text-[#00e5ff]"
                    : "text-transparent"
              }`}
            >
              {value || 0}
            </span>
          );
        })}
      </div>
      <p className="mt-1 text-right font-mono text-[9px] text-white/45">
        move {ply}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1">
      <p className="text-[9px] uppercase tracking-wider text-white/40">{label}</p>
      <p className="font-mono font-bold text-white/85">{value}</p>
    </div>
  );
}

function SummaryChip({ kind, value }: { kind: MarkerKind; value: number }) {
  const meta = MARKER_META[kind];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${meta.chip}`}
    >
      <Icon size={11} aria-hidden="true" />
      {value} {meta.label.toLowerCase()}
      {value === 1 ? "" : "s"}
    </span>
  );
}

function ProgressRow({
  label,
  value,
  max,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  tone: "cyan" | "muted";
}) {
  const safeMax = Math.max(1, max);
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 truncate text-[9px] uppercase tracking-wider text-white/40">
        {label}
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full ${
            tone === "cyan" ? "bg-[#00e5ff]" : "bg-white/35"
          }`}
          style={{ width: `${Math.max(0, Math.min(safeMax, value)) / safeMax * 100}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right font-mono text-[9px] text-white/55">
        {value}/{safeMax}
      </span>
    </div>
  );
}
