"use client";

// src/app/evaluation/[gameKey]/[matchId]/PageClient.tsx
//
// The shared Game Evaluation page (client shell).
//
// WHAT IT DOES
// ------------
// On mount it POSTs to /api/evaluation/[gameKey]/[matchId] — the route from the
// Game Evaluation feature — and renders whatever that route returns. That route
// owns EVERY decision: it is auth-gated, it enforces the Free/Pro daily limit
// with a real database count, it verifies the match belongs to the caller, and
// it caches per (user, game, match). This page never re-implements any of that:
// a 429 is a 429, a 403 is a 403, and the tier/limits in the response are the
// server's, not a client guess.
//
// FIRST CALLS ARE SLOW, ON PURPOSE
// --------------------------------
// Turning the flag is the expensive part: the objective half replays every move
// through a real Stockfish WASM search (~8–20 s for a full game) and then one
// LLM call writes the analysis. So the loading state is a first-class screen,
// not a spinner that flickers — and once generated the result is cached, so the
// second visit is instant (`cached: true`).
//
// THE HEADER IS A SECOND, CHEAP REQUEST
// -------------------------------------
// The evaluation route answers about the EVALUATION; the match header (result,
// opponent, which colour you played) comes from the game's own existing state
// endpoint, the same one the game page already uses. That keeps this page
// game-agnostic: adding a game means adding an evaluator AND a one-line header
// adapter below, mirroring the server's evaluator registry.
//
// SAFETY — AI OUTPUT IS TEXT, NEVER MARKUP
// ----------------------------------------
// Every string produced by the model is rendered as a React text child, so it
// is escaped by React and can never become HTML or JSX. This file never injects
// raw HTML — the "no raw HTML" contract is pinned by tests/evaluation-page.test.mjs.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBolt,
  IconBrain,
  IconBulb,
  IconChartBar,
  IconHeartHandshake,
  IconRobot,
  IconSparkles,
  IconTargetArrow,
  IconThumbUp,
  IconTrophy,
  IconX,
} from "@tabler/icons-react";

import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import InteractiveCasinoBg from "../../../../components/InteractiveCasinoBg";
import FrameAvatar from "../../../../components/FrameAvatar";
import UpgradeProButton from "../../../../components/UpgradeProButton";
import StateShell, {
  stateSecondaryAction,
} from "../../../../components/states/StateShell";
import ErrorState from "../../../../components/states/ErrorState";

// ════════════════════════════════════════════════════════════════════
// Per-game adapters
// ════════════════════════════════════════════════════════════════════

/**
 * The game's own state endpoint, used ONLY to build the match header (who the
 * opponent was, whether you won, which colour you played). The evaluation
 * itself never depends on this — if the header call fails the page still shows
 * the full evaluation, just without the result chip.
 *
 * Chess is the only evaluator today, so it is the only adapter.
 */
const MATCH_HEADER_ENDPOINTS = {
  chess: (matchId) => `/api/chess/game-state?gameId=${encodeURIComponent(matchId)}`,
};

// ════════════════════════════════════════════════════════════════════
// Response shapes (loose on purpose — every field is optional)
// ════════════════════════════════════════════════════════════════════

type InsightKeyMoment = { move?: string; note?: string };

type EvaluationInsight = {
  summary?: string;
  strengths?: string[];
  weaknesses?: string[];
  key_moments?: InsightKeyMoment[];
  improvements?: string[];
  next_time_tip?: string;
};

type PlayerStats = {
  playedBy?: string;
  moveCount?: number;
  accuracyPercent?: number;
  averageCpLoss?: number;
  blunders?: number;
  mistakes?: number;
  bestMoves?: number;
};

type ObjectiveData = {
  sufficient?: boolean;
  moveCount?: number;
  engine?: { id?: string; depth?: number; moveTimeMs?: number } | null;
  players?: { white?: PlayerStats; black?: PlayerStats } | null;
};

type EvaluationLimits = {
  tier?: string;
  dailyLimit?: number | null;
  usedToday?: number;
  remaining?: number | null;
};

type EvaluationData = {
  evaluationId?: string | null;
  gameKey?: string;
  matchId?: string;
  tier?: string;
  cached?: boolean;
  aiAvailable?: boolean;
  objective?: ObjectiveData | null;
  insight?: EvaluationInsight | null;
  limits?: EvaluationLimits | null;
  message?: string | null;
};

type MatchHeader = {
  status?: string;
  result?: string | null;
  winnerId?: string | null;
  viewerRole?: string | null;
  whitePlayerId?: string | null;
  blackPlayerId?: string | null;
  whitePlayerName?: string | null;
  blackPlayerName?: string | null;
};

type Outcome = "win" | "loss" | "draw" | null;

// ════════════════════════════════════════════════════════════════════
// Small helpers
// ════════════════════════════════════════════════════════════════════

/** Rounds a percentage for display, or an em dash when it isn't a number. */
function formatPct(value: unknown): string | number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : "—";
}

/** The outcome from the caller's point of view, or null when unknown. */
function deriveOutcome(match: MatchHeader | null): Outcome {
  if (!match) return null;
  if (match.result === "draw") return "draw";
  if (!match.winnerId) return null;
  const role = match.viewerRole;
  if (role !== "white" && role !== "black") return null;
  const myId = role === "white" ? match.whitePlayerId : match.blackPlayerId;
  if (myId === null || myId === undefined) return null;
  return String(match.winnerId) === String(myId) ? "win" : "loss";
}

/** The opponent's display name + whether they were the house bot. */
function deriveOpponent(
  match: MatchHeader | null,
): { name: string; isAi: boolean } | null {
  if (!match) return null;
  const role = match.viewerRole;
  const name = role === "white" ? match.blackPlayerName : match.whitePlayerName;
  const opponentId = role === "white" ? match.blackPlayerId : match.whitePlayerId;
  return {
    name: name && name !== "Waiting..." ? String(name) : "Opponent",
    isAi: opponentId === null || opponentId === undefined,
  };
}

// ════════════════════════════════════════════════════════════════════
// Presentational pieces (existing GRYND card/typography conventions)
// ════════════════════════════════════════════════════════════════════

const CARD_TONES = {
  cyan: {
    border: "border-[#00e5ff]/25",
    title: "text-[#00e5ff]",
    medallion: "border-[#00e5ff]/40 bg-[#00e5ff]/10 text-[#00e5ff]",
  },
  good: {
    border: "border-emerald-400/30",
    title: "text-emerald-300",
    medallion: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  },
  warn: {
    border: "border-red-400/30",
    title: "text-red-300",
    medallion: "border-red-400/40 bg-red-400/10 text-red-300",
  },
  gold: {
    border: "border-[#f5ff3b]/30",
    title: "text-[#f5ff3b]",
    medallion: "border-[#f5ff3b]/40 bg-[#f5ff3b]/10 text-[#f5ff3b]",
  },
};

function SectionCard({ icon, title, accent = "cyan", children }) {
  const tone = CARD_TONES[accent] || CARD_TONES.cyan;
  return (
    <section
      className={`rounded-2xl border ${tone.border} bg-[#0b224f]/70 p-5 sm:p-6`}
    >
      <h2 className={`flex items-center gap-2 text-lg font-bold ${tone.title}`}>
        <span
          aria-hidden="true"
          className={`flex h-7 w-7 items-center justify-center rounded-lg border ${tone.medallion}`}
        >
          {icon}
        </span>
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A bullet list. Items are plain strings — React escapes them. */
function BulletList({ items, markerClass = "text-[#00e5ff]" }) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li
          key={index}
          className="flex items-start gap-2 text-sm leading-relaxed text-[#d8fbff]/90"
        >
          <span aria-hidden="true" className={`mt-1 ${markerClass}`}>
            •
          </span>
          <span>{String(item)}</span>
        </li>
      ))}
    </ul>
  );
}

function StatTile({
  label,
  value,
  sub = null,
  tone = "text-[#d8fbff]",
}: {
  label: string;
  value: string | number;
  sub?: string | null;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-[#00e5ff]/15 bg-[#08142f]/60 p-3 text-center">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#9dd8ff]/60">
        {label}
      </p>
      <p className={`mt-1 text-xl font-black tabular-nums ${tone}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-[10px] text-[#9dd8ff]/50">{sub}</p> : null}
    </div>
  );
}

function OutcomeChip({ outcome }: { outcome: Outcome }) {
  if (!outcome) return null;
  const map = {
    win: {
      icon: IconTrophy,
      label: "Win",
      cls: "border-emerald-300/50 bg-emerald-400/15 text-emerald-300",
    },
    loss: {
      icon: IconX,
      label: "Loss",
      cls: "border-red-300/50 bg-red-400/15 text-red-300",
    },
    draw: {
      icon: IconHeartHandshake,
      label: "Draw",
      cls: "border-cyan-300/50 bg-cyan-400/15 text-cyan-300",
    },
  }[outcome];
  const Icon = map.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-black uppercase tracking-[0.16em] ${map.cls}`}
    >
      <Icon size={14} aria-hidden="true" />
      {map.label}
    </span>
  );
}

/** The first-call loading screen — the engine + model can take several seconds. */
function AnalyzingPanel() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="rounded-2xl border border-[#00e5ff]/25 bg-[#0b224f]/70 p-6 text-center"
    >
      <span
        aria-hidden="true"
        className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-[#00e5ff]/40 bg-[#00e5ff]/10"
      >
        <IconBrain size={26} className="animate-pulse text-[#00e5ff]" />
      </span>
      <p className="mt-3 text-lg font-bold text-[#c9f7ff]">
        Analysing your match…
      </p>
      <p className="mx-auto mt-1 max-w-md text-sm text-[#9dd8ff]/80">
        The engine replays every move, then your coach writes the analysis. This
        usually takes a few seconds — it only happens once per match.
      </p>
      <div aria-hidden="true" className="mx-auto mt-5 max-w-xs space-y-2">
        {["w-full", "w-4/5", "w-11/12"].map((w) => (
          <div key={w} className={`h-3 animate-pulse rounded-full bg-white/10 ${w}`} />
        ))}
      </div>
    </div>
  );
}

/** The 429 state — an upsell, not an error, using the existing PRO flow. */
function LimitPanel({ message }: { message?: string | null }) {
  return (
    <StateShell
      tone="warning"
      icon={<IconBolt size={24} aria-hidden="true" />}
      title="You've used today's free evaluation"
      description={
        message ||
        "Upgrade to GRYND PRO for unlimited game evaluations. Your free evaluation resets every day."
      }
    >
      <UpgradeProButton />
      <Link href="/casino" className={stateSecondaryAction}>
        <IconArrowLeft size={16} aria-hidden="true" />
        Back to games
      </Link>
    </StateShell>
  );
}

// ════════════════════════════════════════════════════════════════════
// The evaluation body
// ════════════════════════════════════════════════════════════════════

/** The rendered evaluation body (exported so it can be reused/previewed). */
export function EvaluationResult({
  evaluation,
  viewerRole,
}: {
  evaluation: EvaluationData;
  viewerRole?: string | null;
}) {
  const insight = evaluation.insight || null;
  const objective = evaluation.objective || null;

  const roleKnown = viewerRole === "white" || viewerRole === "black";
  const myColor = viewerRole === "black" ? "black" : "white";
  const otherColor = myColor === "white" ? "black" : "white";
  const me = objective?.sufficient ? objective?.players?.[myColor] : null;
  const foe = objective?.sufficient ? objective?.players?.[otherColor] : null;
  const mineLabel = roleKnown ? "Your" : "White";
  const theirsLabel = roleKnown ? "Opponent" : "Black";

  const strengths = Array.isArray(insight?.strengths) ? insight.strengths : [];
  const weaknesses = Array.isArray(insight?.weaknesses) ? insight.weaknesses : [];
  const improvements = Array.isArray(insight?.improvements)
    ? insight.improvements
    : [];
  const keyMoments = Array.isArray(insight?.key_moments)
    ? insight.key_moments.filter((m) => m && (m.move || m.note))
    : [];

  const engine = objective?.engine;
  const limits = evaluation.limits;

  return (
    <div className="space-y-5">
      {/* ── AI Evaluation summary (or the honest fallback) ─────────── */}
      {insight?.summary ? (
        <SectionCard
          icon={<IconSparkles size={16} aria-hidden="true" />}
          title="AI Evaluation"
        >
          {/* Plain text: React escapes this string, so model output can never
              become markup. */}
          <p className="text-sm leading-relaxed text-[#d8fbff]/90">
            {insight.summary}
          </p>
          {evaluation.cached ? (
            <p className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-[#00e5ff]/25 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#9dd8ff]/70">
              Saved evaluation
            </p>
          ) : null}
        </SectionCard>
      ) : (
        <SectionCard
          accent="warn"
          icon={<IconAlertTriangle size={16} aria-hidden="true" />}
          title="AI analysis unavailable"
        >
          <p className="text-sm leading-relaxed text-[#d8fbff]/90">
            {evaluation.message ||
              "The AI coach is temporarily unavailable. Your objective match statistics were still computed from your game and are shown below."}
          </p>
        </SectionCard>
      )}

      {/* ── Objective stats (real numbers, never model output) ─────── */}
      {objective?.sufficient ? (
        <SectionCard
          icon={<IconChartBar size={16} aria-hidden="true" />}
          title="Match at a Glance"
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile
              label={`${mineLabel} accuracy`}
              value={`${formatPct(me?.accuracyPercent)}%`}
              sub={
                foe ? `${theirsLabel} ${formatPct(foe.accuracyPercent)}%` : null
              }
              tone="text-[#f5ff3b]"
            />
            <StatTile
              label="Blunders"
              value={me?.blunders ?? "—"}
              tone="text-red-300"
            />
            <StatTile
              label="Mistakes"
              value={me?.mistakes ?? "—"}
              tone="text-amber-300"
            />
            <StatTile
              label="Best moves"
              value={me?.bestMoves ?? "—"}
              tone="text-emerald-300"
            />
          </div>
          <p className="mt-3 text-[11px] text-[#9dd8ff]/50">
            {objective.moveCount ?? 0} moves played
            {engine?.id
              ? ` · judged by ${engine.id}${engine.depth ? ` at depth ${engine.depth}` : ""}`
              : ""}
          </p>
        </SectionCard>
      ) : null}

      {/* ── Strengths ──────────────────────────────────────────────── */}
      {strengths.length > 0 ? (
        <SectionCard
          accent="good"
          icon={<IconThumbUp size={16} aria-hidden="true" />}
          title="Strengths"
        >
          <BulletList items={strengths} markerClass="text-emerald-300" />
        </SectionCard>
      ) : null}

      {/* ── Weaknesses ─────────────────────────────────────────────── */}
      {weaknesses.length > 0 ? (
        <SectionCard
          accent="warn"
          icon={<IconAlertTriangle size={16} aria-hidden="true" />}
          title="Weaknesses"
        >
          <BulletList items={weaknesses} markerClass="text-red-300" />
        </SectionCard>
      ) : null}

      {/* ── Key moments ────────────────────────────────────────────── */}
      {keyMoments.length > 0 ? (
        <SectionCard
          accent="gold"
          icon={<IconBolt size={16} aria-hidden="true" />}
          title="Key Moments"
        >
          <ul className="space-y-3">
            {keyMoments.map((moment, index) => (
              <li
                key={index}
                className="rounded-xl border border-[#f5ff3b]/20 bg-[#08142f]/60 p-3"
              >
                {moment.move ? (
                  <p className="text-sm font-bold text-[#f5ff3b]">
                    {String(moment.move)}
                  </p>
                ) : null}
                {moment.note ? (
                  <p className="mt-1 text-sm leading-relaxed text-[#d8fbff]/85">
                    {String(moment.note)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {/* ── Improvements ───────────────────────────────────────────── */}
      {improvements.length > 0 ? (
        <SectionCard
          icon={<IconTargetArrow size={16} aria-hidden="true" />}
          title="Improvements"
        >
          <BulletList items={improvements} />
        </SectionCard>
      ) : null}

      {/* ── Next time tip ──────────────────────────────────────────── */}
      {insight?.next_time_tip ? (
        <SectionCard
          accent="gold"
          icon={<IconBulb size={16} aria-hidden="true" />}
          title="Next Time Tip"
        >
          <p className="text-sm leading-relaxed text-[#d8fbff]/90">
            {insight.next_time_tip}
          </p>
        </SectionCard>
      ) : null}

      {/* ── Free-tier allowance note ───────────────────────────────── */}
      {limits?.tier === "free" && limits?.dailyLimit ? (
        <p className="text-center text-xs text-[#9dd8ff]/60">
          Free tier · {limits.usedToday ?? 0} of {limits.dailyLimit} evaluation
          {limits.dailyLimit === 1 ? "" : "s"} used today.{" "}
          <Link href="/upgrade-pro" className="font-semibold text-[#f5ff3b] underline">
            Go unlimited
          </Link>
        </p>
      ) : null}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// The page
// ════════════════════════════════════════════════════════════════════

export default function EvaluationPageClient({ gameLabel = "Game" }) {
  const params = useParams();
  const gameKey = String(params?.gameKey ?? "")
    .trim()
    .toLowerCase();
  const matchId = String(params?.matchId ?? "").trim();
  const shortId = matchId.length > 8 ? matchId.slice(0, 8) : matchId;

  const [phase, setPhase] = useState("loading"); // loading | ready | limit | error
  const [evaluation, setEvaluation] = useState(null);
  const [limitMessage, setLimitMessage] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [match, setMatch] = useState(null);

  const reduceMotion = useReducedMotion();

  // ── Run the evaluation (once per match) ───────────────────────────
  const load = useCallback(async () => {
    setPhase("loading");
    setErrorMessage(null);
    try {
      const res = await fetch(
        `/api/evaluation/${encodeURIComponent(gameKey)}/${encodeURIComponent(matchId)}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        },
      );
      const json = await res.json().catch(() => null);

      // The server says we're out of evaluations — an upsell, not an error.
      if (res.status === 429) {
        setLimitMessage(json?.error || null);
        setPhase("limit");
        return;
      }
      if (!res.ok || !json?.success) {
        setErrorMessage(
          json?.error || "We couldn't generate this evaluation. Please try again.",
        );
        setPhase("error");
        return;
      }
      setEvaluation(json.data || null);
      setPhase("ready");
    } catch {
      setErrorMessage(
        "We couldn't reach the evaluation service. Check your connection and try again.",
      );
      setPhase("error");
    }
  }, [gameKey, matchId]);

  // Guard against a double-invoke (React dev strict mode): a match must be
  // evaluated once per page load, not twice.
  const startedForRef = useRef(null);
  useEffect(() => {
    const key = `${gameKey}/${matchId}`;
    if (startedForRef.current === key) return;
    startedForRef.current = key;
    void load();
  }, [gameKey, matchId, load]);

  // ── Match header (result, opponent) ───────────────────────────────
  useEffect(() => {
    const buildUrl = MATCH_HEADER_ENDPOINTS[gameKey];
    if (!buildUrl || !matchId) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    fetch(buildUrl(matchId), {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json?.data) setMatch(json.data);
      })
      .catch(() => {
        // The header is decorative: a failure just hides the result chip.
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [gameKey, matchId]);

  const outcome = deriveOutcome(match);
  const opponent = deriveOpponent(match);

  return (
    <div className="relative min-h-screen">
      <InteractiveCasinoBg variant="subtle" />
      <NavigationBar currentPath="/evaluation" />

      <main className="relative z-10 mx-auto max-w-3xl px-4 pb-20 pt-24 sm:pt-28">
        <header className="mb-6 text-center">
          <p className="text-[11px] font-black uppercase tracking-[0.3em] text-[#00e5ff]/80">
            Game Evaluation
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-[#f5ff3b] drop-shadow-[0_0_10px_rgba(245,255,59,0.5)] sm:text-4xl">
            {gameLabel}
          </h1>
          {shortId ? (
            <p className="mt-1 text-xs text-[#9dd8ff]/70">Match #{shortId}</p>
          ) : null}
        </header>

        {/* Match header — result + opponent from the game's own state API */}
        {match ? (
          <div className="mb-6 flex flex-col items-center justify-between gap-4 rounded-2xl border border-[#00e5ff]/25 bg-[#0b224f]/70 p-5 sm:flex-row">
            {opponent ? (
              <div className="flex items-center gap-3">
                <FrameAvatar name={opponent.name} size="h-12 w-12" />
                <div className="min-w-0 text-left">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9dd8ff]/60">
                    Opponent
                  </p>
                  <p className="truncate text-sm font-bold text-[#f5ff3b]">
                    {opponent.isAi ? (
                      <span className="inline-flex items-center gap-1">
                        <IconRobot
                          size={15}
                          className="text-cyan-300"
                          aria-hidden="true"
                        />
                        {opponent.name}
                      </span>
                    ) : (
                      opponent.name
                    )}
                  </p>
                </div>
              </div>
            ) : (
              <span />
            )}
            <OutcomeChip outcome={outcome} />
          </div>
        ) : null}

        {phase === "loading" ? <AnalyzingPanel /> : null}

        {phase === "limit" ? <LimitPanel message={limitMessage} /> : null}

        {phase === "error" ? (
          <ErrorState
            title="We couldn't load this evaluation"
            description={errorMessage}
            onRetry={load}
            homeHref="/casino"
          />
        ) : null}

        {phase === "ready" && evaluation ? (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            <EvaluationResult
              evaluation={evaluation}
              viewerRole={match?.viewerRole}
            />
          </motion.div>
        ) : null}

        {phase === "ready" && !evaluation ? (
          <ErrorState
            title="Nothing to show yet"
            description="The evaluation came back empty. Please try again."
            onRetry={load}
            homeHref="/casino"
          />
        ) : null}
      </main>

      <Footer />
    </div>
  );
}
