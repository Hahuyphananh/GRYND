"use client";

// src/components/lobby/PvpLobby.jsx
//
// Shared lobby for the casino's 1v1 PvP games. It reproduces the
// casino lobby design — ink-black page, uppercase kickers, one dark
// aside panel carrying the stake picker and the actions, then the
// open-lobby list below — so every game lobby reads as the same
// product.
//
// Usage — standalone lobby page:
//   <PvpLobbyPage title="..." subtitle="..." icon={...} ... />
//
// Usage — inline lobby section (games that render the lobby and the
// board on the same route):
//   <PvpLobby title="..." ... />
//   (wrap it yourself; it renders only the lobby content, no page
//   chrome)
//
// The component is intentionally data-driven: each game wires its own
// fetch/create/join callbacks and lobby-row renderers. The visual
// chrome is the only thing shared, which is exactly the point — every
// game lobby looks the same.

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { useRouter, usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import NavigationBar from "../navigation-bar";
import Footer from "../Footer";
import MatchWaiting from "./MatchWaiting";
import { usePlatformQuickQueue } from "./PlatformQuickQueue";
import DailyLossGuard from "../DailyLossGuard";
import { GLOBAL_MAX_BET } from "../../lib/games/economy";
import { isPortalPlayPath } from "../../lib/portal/framing";
import SessionGuard from "../SessionGuard";
import {
  IconRefresh,
  IconNotebook,
  IconAlertTriangle,
  IconRobot,
  IconDeviceGamepad2,
  IconBook,
  IconX,
} from "@tabler/icons-react";

export function CoinIcon({ className = "" }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <ellipse cx="12" cy="6" rx="8" ry="2.5" />
      <path d="M4 6 V18 a8 2.5 0 0 0 16 0 V6" />
      <ellipse cx="12" cy="18" rx="8" ry="2.5" />
    </svg>
  );
}

function LoadingDotsIcon({ className = "" }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <circle cx="6" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="18" cy="12" r="2" />
    </svg>
  );
}

// Shared palette tokens — keep the accents consistent across games.
const PALETTE = {
  page: "bg-[#07080b]",
  card: "border-white/10 bg-[#0b0d12]",
  kicker: "text-cyan-300/70",
  title: "text-white",
  chipActive:
    "border-cyan-400/60 bg-cyan-400/10 text-cyan-200 shadow-[0_0_15px_rgba(34,211,238,0.18)]",
  chipIdle:
    "border-white/10 bg-white/[0.03] text-white/50 hover:border-white/25 hover:text-white",
  play:
    "bg-cyan-400 text-[#04121a] hover:bg-cyan-300 shadow-[0_20px_50px_-30px_rgba(34,211,238,0.9)]",
  vsAi:
    "border border-violet-400/40 bg-violet-400/10 text-violet-200 hover:bg-violet-400/20",
  sectionTitle: "text-white/40",
  join: "bg-cyan-400 text-[#04121a] hover:bg-cyan-300",
  row: "border-white/10 bg-white/[0.02] hover:border-white/20",
  ghost:
    "border border-white/15 bg-white/[0.03] text-white/70 hover:border-white/30 hover:text-white",
};

/**
 * Number formatting for anything rendered into the lobby markup.
 *
 * These must be byte-identical on the server and in the browser. Passing
 * `undefined` as the locale uses whatever the runtime has — Node and the
 * browser disagree on the grouping separator (and on digits/separators in
 * other locales), which React reports as a hydration mismatch and answers by
 * throwing the server-rendered tree away and re-rendering it on the client.
 * Pinning the locale keeps the HTML the crawler receives identical to what a
 * visitor sees, and keeps commas where this UI always put them.
 */
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

/** Grouped integer, e.g. 1000 → "1,000". */
export function formatTokens(value) {
  const n = Number(value);
  return NUMBER_FORMAT.format(Number.isFinite(n) ? n : 0);
}

/**
 * CoinWagerPicker — the stake selector for a coin lobby.
 *
 * Coins are the energy currency (src/lib/games/economy.ts): a small balance, a
 * bounded daily top-up, a hard ceiling on a single wager. The picker is
 * presentational — the lobby owns the value — so every game gets the same
 * control and the same presets. `balance` is the player's live balance (null
 * when unknown/signed out); an unaffordable stake is flagged here and rejected
 * by the server regardless.
 */
export function CoinWagerPicker({
  value,
  onChange,
  presets = [5, 10, 25, 50, GLOBAL_MAX_BET],
  min = 1,
  max = GLOBAL_MAX_BET,
  balance = null,
  label = "Stake",
}) {
  const stake = Number(value) || 0;
  const insufficient =
    balance !== null && Number.isFinite(Number(balance)) && stake > Number(balance);
  return (
    <div>
      <label className="text-[11px] font-black uppercase tracking-[0.28em] text-white/35">
        {label}
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {presets.map((preset) => {
          const disabled = preset < min || preset > max;
          return (
            <button
              key={preset}
              type="button"
              onClick={() => onChange(preset)}
              disabled={disabled}
              aria-pressed={stake === preset}
              className={`rounded-lg border px-2.5 py-1 text-xs font-bold tabular-nums transition disabled:cursor-not-allowed disabled:opacity-40 ${
                stake === preset ? PALETTE.chipActive : PALETTE.chipIdle
              }`}
            >
              {formatTokens(preset)}
            </button>
          );
        })}
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={Number.isFinite(stake) ? stake : ""}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label="Custom stake in coins"
          className="w-20 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-xs font-bold tabular-nums text-white focus:border-cyan-400/60 focus:outline-hidden"
        />
      </div>
      <p
        className={`mt-1.5 text-[11px] ${
          insufficient ? "font-semibold text-red-300" : "text-white/40"
        }`}
      >
        {balance === null
          ? `Between ${formatTokens(min)} and ${formatTokens(max)} coins`
          : insufficient
            ? `Not enough coins — you have ${formatTokens(balance)}`
            : `Balance: ${formatTokens(balance)} coins`}
      </p>
    </div>
  );
}

/**
 * RulesModal — a "How to Play" overlay in the shared lobby palette. Each
 * section is { heading, body } where body may be JSX. Shared by every
 * game lobby so the rules popup looks identical across the casino.
 */
export function RulesModal({ title = "How to Play", sections = [], onClose }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-xs"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, opacity: 0, y: 16 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 16 }}
        transition={{ type: "spring", stiffness: 300, damping: 28 }}
        className="relative w-full max-w-lg max-h-[88vh] overflow-hidden rounded-2xl border border-white/10 bg-[#0b0d12] shadow-[0_40px_120px_-40px_rgba(34,211,238,0.35)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-cyan-400/60 to-transparent" />

        <div className="relative flex items-center justify-between border-b border-white/[0.07] px-6 pb-4 pt-6">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.32em] text-white/30">Rules</p>
            <h2 className="mt-1 flex items-center gap-2 text-xl font-black tracking-tight text-white">
              <IconBook size={18} className="text-cyan-300" /> {title}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close rules"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-white/40 transition hover:border-white/30 hover:text-white"
          >
            <IconX size={16} />
          </button>
        </div>

        <div
          role="region"
          aria-label="Open games"
          tabIndex={0}
          className="relative max-h-[calc(88vh-150px)] space-y-3 overflow-y-auto px-6 py-5"
        >
          {sections.map((s, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04, duration: 0.22 }}
              className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4"
            >
              <h3 className="mb-1.5 flex items-center gap-2 text-sm font-bold text-white/90">
                <span className="text-cyan-300/70">{String(i + 1).padStart(2, "0")}</span> {s.heading}
              </h3>
              <div className="text-sm leading-relaxed text-white/55">{s.body}</div>
            </motion.div>
          ))}
        </div>

        <div className="relative border-t border-white/[0.07] px-6 py-4">
          <button
            onClick={onClose}
            className="w-full rounded-xl bg-cyan-400 py-3 text-sm font-black uppercase tracking-[0.14em] text-[#04121a] transition hover:bg-cyan-300"
          >
            Got it
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/**
 * useFirstVisitRules — returns true on the player's first visit to a
 * game (keyed by `rulesKey`), and remembers that visit in localStorage
 * so the "How to Play" modal auto-opens only once per game.
 */
export function useFirstVisitRules(rulesKey) {
  const [isFirstVisit, setIsFirstVisit] = useState(false);

  useEffect(() => {
    if (!rulesKey) return;
    let cancelled = false;
    const key = `casino-rules-seen:${rulesKey}`;
    try {
      if (localStorage.getItem(key)) return; // already seen — never auto-open
    } catch {
      // localStorage unavailable (private mode) — skip auto-open
      return;
    }
    // Defer the auto-open until the page's route transition has settled
    // (client-side navs briefly remount the page and animate a 250ms
    // fade). Mounting the rules modal mid-transition makes framer-motion
    // treat the whole page as exiting, leaving it stuck at opacity 0 over
    // the page background. Only mark the game as "seen" once the modal
    // actually opens, so a remount can't consume the first-visit flag.
    const timer = setTimeout(() => {
      if (cancelled) return;
      try {
        localStorage.setItem(key, "1");
      } catch {}
      setIsFirstVisit(true);
    }, 750);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rulesKey]);

  return isFirstVisit;
}

/**
 * Lobby content (no page chrome) — use inside an existing page layout.
 */
/**
 * LobbyTitle — the wordmark, in the shared lobby's treatment.
 *
 * The wordmark shows the title in white, its final word in a cyan→violet
 * gradient. Every
 * lobby gets the same split on its final word, so a two-word title reads as one
 * product across the casino. A single-word title takes the gradient whole, and
 * a JSX title is rendered untouched (it may already carry its own styling).
 */
function LobbyTitle({ title }) {
  if (typeof title !== "string") return <span>{title}</span>;
  const words = title.trim().split(/\s+/);
  if (words.length < 2) {
    return (
      <span className="bg-linear-to-r from-cyan-300 to-violet-300 bg-clip-text text-transparent">
        {title}
      </span>
    );
  }
  const accent = words.pop();
  return (
    <>
      <span>{words.join(" ")}</span>
      <span className="bg-linear-to-r from-cyan-300 to-violet-300 bg-clip-text text-transparent">
        {accent}
      </span>
    </>
  );
}

export function PvpLobby({
  // The responsible-play break reminder. It is ON everywhere except Solitaire,
  // which opts out through `sessionReminder={false}`: a lobby that reports
  // elapsed play time is a nag on a game people drop into for a quick deal.
  sessionReminder = true,
  // identity
  title,
  subtitle,
  icon = null,
  // rules (How to Play modal at the top of the lobby)
  rules = null,
  rulesLabel = "How to Play",
  // first-visit auto-open key (per-game, e.g. "lane-runner")
  rulesKey = null,
  // main actions
  busy = false,
  onPlay,
  playLabel = "Play",
  playBusyLabel = "Finding match…",
  canPlay = true,
  vsAi = null, // { label, onClick, disabled, busy }
  extraActions = null,
  // coin wager, or null for a free lobby. Shape:
  //   { value, onChange, presets?, min?, max?, balance?, label? }
  // When present the lobby renders the stake picker instead of the
  // "free play" chrome (see CoinWagerPicker).
  wager = null,
  // game-specific context line shown under the searching overlay title
  // (e.g. "Pairing you with a player on the same stake…")
  waitingSubtitle = null,
  // error
  error = null,
  // open lobbies
  lobbies = [],
  // True until the first list response lands. While loading we show a skeleton
  // instead of the empty-state text, so a new visitor never sees "no open
  // lobbies" flash before the request resolves.
  lobbiesLoading = false,
  lobbyEmptyText = "No open lobbies yet. Be the first to make one.",
  lobbyKey = (l) => l?.id,
  lobbyTitle = (l) => <>Lobby #{l?.id}</>,
  lobbyMeta = null,
  onJoin,
  joinBusyId = null,
  joinLabel = "Join",
  onRefresh,
  historyHref = null,
  // Where the ghost "back" action points. The homepage IS the lobby, so it
  // sends the player to the rules rather than a games hub.
  backHref = "/games",
  backLabel = "← Back to games",
  // "your open lobby" banner
  myOpenId = null,
  onResume,
  onCancel,
  cancelling = false,
  // platform-wide Quick Queue readiness
  quickQueue = null, // { ready, busy, error, onToggle, disabled, label, preferences }

  // extra content inside the main card (e.g. difficulty pickers)
  children = null,
  // trailing content after the lobbies card (e.g. rules box)
  after = null,
  // PRACTICE-ONLY MODE.
  //
  // Renders the lobby as a practice entry point: no stake picker, no online
  // Play button, no open-lobby list, no quick queue, no route to sign-in and no
  // outbound site link. The game's own practice action (`vsAi`, or whatever the
  // page passes through `extraActions`) is the only way to start, which is
  // exactly what a portal visitor can do: they have no account and no age
  // record, so an online action could only ever bounce them.
  //
  // `undefined` (the default) means "decide from the route": practice-only on
  // the portal surface (/play/<gameKey>), normal everywhere else. Passing true
  // or false overrides that, which is what a test or a future game may want.
  practiceOnly = undefined,
}) {
  const [showRules, setShowRules] = useState(false);
  const firstVisit = useFirstVisitRules(rulesKey);
  // Pages pass `rules` as an inline object, so its identity changes on
  // every render (lobby polling, socket events, …). Without a guard the
  // auto-open effect below re-fires on every re-render and re-opens the
  // modal after the player already dismissed it — only open it once per
  // mount.
  const autoOpenedRef = useRef(false);

  useEffect(() => {
    if (firstVisit && rules && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setShowRules(true);
    }
  }, [firstVisit, rules]);

  const filteredLobbies = myOpenId !== null && myOpenId !== undefined
    ? lobbies.filter((l) => l?.id !== myOpenId)
    : lobbies;

  // ── Signed-out visitors ────────────────────────────────────────────────
  // Game lobbies are public, so a visitor with no account can read the rules,
  // the open-lobby list and every card. The account requirement lands on the
  // PLAY action instead of the page: clicking Play sends them to sign-in with a
  // return path, rather than a dead disabled button. Practice vs AI is handled
  // separately (it stays open to guests), so only this online action routes.
  const { isSignedIn, isLoaded } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const signedOut = isLoaded && !isSignedIn;
  // The portal surface is chrome-free and account-free by design (see
  // src/app/play and components/SiteChrome), so the shared lobby renders its
  // practice-only form there without every game having to opt in.
  const practiceMode = practiceOnly === undefined ? isPortalPlayPath(pathname) : Boolean(practiceOnly);
  const handlePlay = () => {
    if (!signedOut) {
      onPlay?.();
      return;
    }
    router.push(`/sign-in?redirect_url=${encodeURIComponent(pathname || "/")}`);
  };

  return (
    <DailyLossGuard>
      {sessionReminder && <SessionGuard />}
      {/* Unified full-screen "Searching for a match…" takeover — shown
          whenever a Play / Join / vs-AI action is in flight. Every game
          that renders this shared lobby gets the identical waiting
          screen (GRYND logo + radar sweep) for free; games pass a
          `waitingSubtitle` for a game-specific context line. */}
      {(busy || vsAi?.busy || joinBusyId !== null) && (
        <MatchWaiting
          state="searching"
          gameName={typeof title === "string" ? title : undefined}
          subtitle={waitingSubtitle}
        />
      )}

      {/* The hero and the match panel are aligned on their TOP edge, exactly as
          the casino hero reads: the title block starts level with the panel
          instead of being dropped to meet the panel's bottom. `items-end` pulled
          the hero down by however much taller the panel happened to be, which on
          this shared chrome (a short hero beside a tall facts/queue card) sank
          the title and description well below the panel's top. Below `lg` the
          grid is a single column, so this changes nothing on a phone. */}
      <section className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        {/* The casino lobby shape, kept identical across the casino: uppercase
            kicker → wordmark with a gradient final word → the ONE action row
            (primary, violet practice action, ghost exit, mode pill) →
            parameters (the stake) directly under it. */}
        <div>
          <motion.p
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className={`text-[11px] font-black uppercase tracking-[0.42em] ${PALETTE.kicker}`}
          >
            {practiceMode ? "GRYND · practice" : "GRYND · 1v1 duel"}
          </motion.p>
          {title && (
            <motion.h1
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35 }}
              className={`mt-3 flex flex-wrap items-center gap-3 text-4xl font-black leading-[0.95] tracking-tight sm:text-5xl lg:text-6xl ${PALETTE.title}`}
            >
              {icon}
              <LobbyTitle title={title} />
            </motion.h1>
          )}
          {subtitle && (
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-white/60 sm:text-base">{subtitle}</p>
          )}

          {/* The action row. Same order and weights as every lobby: solid
              cyan primary, violet secondary, a ghost exit, then the mode. */}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {/* Online matchmaking — never in practice-only mode. */}
            {!practiceMode && (
              <button
                type="button"
                onClick={handlePlay}
                disabled={busy || (!canPlay && !signedOut)}
                className={`inline-flex h-12 items-center justify-center gap-2 rounded-xl px-6 text-sm font-black uppercase tracking-[0.14em] transition disabled:cursor-not-allowed disabled:opacity-50 ${PALETTE.play}`}
              >
                {busy ? (
                  <>
                    <LoadingDotsIcon className="h-4 w-4 animate-pulse text-black" />
                    <span>{playBusyLabel}</span>
                  </>
                ) : (
                  <span>{signedOut ? "Sign in to play" : playLabel}</span>
                )}
              </button>
            )}
            {vsAi && (
              <button
                type="button"
                onClick={vsAi.onClick}
                disabled={vsAi.disabled || busy}
                className={`inline-flex h-12 items-center justify-center gap-2 rounded-xl px-5 text-sm font-black uppercase tracking-[0.14em] transition disabled:cursor-not-allowed disabled:opacity-40 ${PALETTE.vsAi}`}
              >
                <IconRobot size={16} className="opacity-70" />
                {vsAi.busy ? "Starting…" : vsAi.label}
                {vsAi.badge && (
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-white/60">
                    {vsAi.badge}
                  </span>
                )}
              </button>
            )}
            {extraActions}
            {/* No route back into the site from a portal surface: a portal
                frame must not offer outbound navigation. */}
            {!practiceMode && (
              <Link
                href={backHref}
                className={`inline-flex h-12 items-center justify-center rounded-xl px-5 text-sm font-bold transition ${PALETTE.ghost}`}
              >
                {backLabel}
              </Link>
            )}
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-[11px] font-semibold text-white/40">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {practiceMode
                ? "Practice · unrated"
                : wager
                  ? "Coin · both stakes escrowed"
                  : "Free play · no tokens at stake"}
            </span>
          </div>

          {error && (
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-400/[0.07] px-3 py-2 text-sm text-red-200">
              <IconAlertTriangle className="h-4 w-4 flex-shrink-0 text-red-300" />
              <span>{error}</span>
            </div>
          )}

          {/* The stake picker is an online-money control: it has no meaning to
              a visitor who cannot stake anything. */}
          {wager && !practiceMode && (
            <div className="mt-5">
              <CoinWagerPicker {...wager} />
            </div>
          )}

          {rules && (
            <div className="mt-5">
              <button
                type="button"
                onClick={() => setShowRules(true)}
                className={`inline-flex h-10 items-center gap-1.5 rounded-xl px-4 text-[11px] font-black uppercase tracking-[0.16em] transition ${PALETTE.ghost}`}
              >
                <IconBook size={14} /> {rulesLabel}
              </button>
            </div>
          )}
        </div>

        {/* ── The match panel ──────────────────────────────────────────── */}
        {/* The casino lobby's aside: one dark card with a cyan top hairline carrying
            the FACTS of the match. The actions live in the hero, so this panel
            never competes with them for the player's first tap. */}
        <motion.aside
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className={`relative overflow-hidden rounded-2xl border p-5 shadow-[0_30px_80px_-50px_rgba(34,211,238,0.55)] ${PALETTE.card}`}
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-cyan-400/60 to-transparent" />

          <p className="text-[11px] font-black uppercase tracking-[0.28em] text-white/35">The match</p>

          {/* Your own open match notification */}
          <AnimatePresence>
            {!practiceMode && myOpenId !== null && myOpenId !== undefined && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-cyan-400/30 bg-cyan-400/[0.07] px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2 text-xs text-cyan-100/80">
                  <LoadingDotsIcon className="h-4 w-4 animate-pulse text-cyan-200" />
                  Your table is waiting for an opponent…
                </span>
                <div className="flex items-center gap-2">
                  {onResume && (
                    <button
                      onClick={() => onResume(myOpenId)}
                      className="rounded-lg bg-cyan-400 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-[#04121a] transition hover:bg-cyan-300"
                    >
                      Resume
                    </button>
                  )}
                  {onCancel && (
                    <button
                      onClick={() => onCancel(myOpenId)}
                      disabled={cancelling}
                      className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-1.5 text-[11px] font-bold text-red-200 transition hover:border-red-400/60 disabled:opacity-50"
                    >
                      {cancelling ? "Cancelling…" : "Cancel"}
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <dl className="mt-4 space-y-3 text-sm">
            {(practiceMode
              ? [
                  ["Entry", "Free"],
                  ["Opponent", "The bot"],
                  ["Rated", "No"],
                  ["Progress", "Saved in this browser"],
                ]
              : [
                  ["Entry", wager ? `${formatTokens(wager?.value ?? 0)} coins` : "Free"],
                  ["Opponent", "Live player"],
                  ["Winner", wager ? "Takes 1.8× the stake" : "First to solve it"],
                  ["Draw", wager ? "Both seats refunded" : "No rating change"],
                ]
            ).map(([label, value]) => (
              <div
                key={label}
                className="flex items-center justify-between border-b border-white/[0.06] pb-2.5"
              >
                <dt className="text-white/40">{label}</dt>
                <dd className="font-semibold text-white/85">{value}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-4 text-xs leading-relaxed text-white/40">
            {practiceMode ? (
              <>
                Practice against the bot. Nothing is wagered, no opponent is
                matched, and the result is unrated — no coins, trophies or
                ranking change.
              </>
            ) : wager ? (
              <>
                Coins are energy: both stakes are escrowed on match-up and the
                winner takes <b className="text-white/70">1.8× their stake</b>{" "}
                (stake back + 90% of the loser&apos;s). An exact draw refunds both
                seats.
              </>
            ) : (
              <>Free to play — nothing is escrowed and no tokens are at stake.</>
            )}
          </p>

          {quickQueue && quickQueue.hasGames !== false && !practiceMode && (
            <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-cyan-200/80">
                    Platform Quick Queue
                  </p>
                  <p className="mt-1 text-xs text-white/45">
                    {quickQueue.ready
                      ? "You’re ready across your selected eligible games."
                      : "Get notified when a compatible game becomes available."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={quickQueue.onToggle}
                  disabled={quickQueue.disabled || quickQueue.busy || quickQueue.emptySelection}
                  aria-pressed={Boolean(quickQueue.ready)}
                  className={`rounded-xl px-4 py-2.5 text-[11px] font-black uppercase tracking-[0.14em] transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    quickQueue.ready
                      ? "bg-emerald-400 text-[#04121a] hover:bg-emerald-300"
                      : "bg-cyan-400 text-[#04121a] hover:bg-cyan-300"
                  }`}
                >
                  {quickQueue.busy ? "Updating…" : quickQueue.label || (quickQueue.ready ? "Not Ready" : "I’m Ready")}
                </button>
              </div>
              {quickQueue.preferences}
              {quickQueue.emptySelection && (
                <p className="mt-2 text-xs text-amber-200">Select at least one game before becoming ready.</p>
              )}
              {quickQueue.notification && (
                <p className="mt-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200" role="status">
                  {quickQueue.notification.message}
                </p>
              )}
              {quickQueue.error && <p className="mt-2 text-xs text-red-200">{quickQueue.error}</p>}
            </div>
          )}

          {children}
        </motion.aside>
      </section>

      {/* ── Open lobbies ─────────────────────────────────────────────── */}
      {/* The casino lobby's section rhythm: a small uppercase header with the
          secondary controls on the right, then flat cards — no heavy panel. */}
      {/* Online matchmaking board — nothing here can be used without an
          account, so practice-only mode does not render it at all. */}
      {!practiceMode && (
      <section className="mt-12 lg:mt-16">
        <div className="flex items-baseline justify-between">
          <h2 className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.32em] text-white/40">
            <IconDeviceGamepad2 className="h-4 w-4" />
            Open Lobbies
          </h2>
          <div className="flex items-center gap-2">
            {historyHref && (
              <Link
                href={historyHref}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold transition ${PALETTE.ghost}`}
              >
                <IconNotebook className="h-3.5 w-3.5" />
                History
              </Link>
            )}
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.12em] transition hover:brightness-110 ${PALETTE.join}`}
              >
                <IconRefresh className="h-3.5 w-3.5" />
                Refresh
              </button>
            )}
          </div>
        </div>
        {lobbiesLoading && filteredLobbies.length === 0 ? (
          <div className="mt-4 space-y-2.5" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={`flex items-center justify-between rounded-2xl border p-4 ${PALETTE.row}`}
              >
                <div className="space-y-2">
                  <div className="h-3.5 w-32 animate-pulse rounded-sm bg-white/10" />
                  <div className="h-2.5 w-20 animate-pulse rounded-sm bg-white/5" />
                </div>
                <div className="h-7 w-16 animate-pulse rounded-lg bg-white/10" />
              </div>
            ))}
            <span className="sr-only">Loading open lobbies…</span>
          </div>
        ) : filteredLobbies.length === 0 ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-white/45">
            <IconDeviceGamepad2 className="h-4 w-4 text-white/25" />
            <span>{lobbyEmptyText}</span>
          </div>
        ) : (
          <div className="mt-4 space-y-2.5">
            {filteredLobbies.map((l) => {
              const key = lobbyKey(l);
              return (
                <div
                  key={key}
                  className={`flex items-center justify-between rounded-2xl border p-4 transition ${PALETTE.row}`}
                >
                  <div>
                    <p className="text-sm font-semibold text-white/90">{lobbyTitle(l)}</p>
                    {lobbyMeta && <p className="mt-0.5 text-xs text-white/50">{lobbyMeta(l)}</p>}
                  </div>
                  {onJoin && (
                    <button
                      type="button"
                      onClick={() => onJoin(l)}
                      disabled={busy || joinBusyId === key}
                      className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-black uppercase tracking-[0.12em] transition hover:brightness-110 disabled:bg-white/10 disabled:text-white/40 ${PALETTE.join}`}
                    >
                      {joinBusyId === key ? (
                        <>
                          <LoadingDotsIcon className="h-3.5 w-3.5 animate-pulse text-black" />
                          <span>Joining…</span>
                        </>
                      ) : (
                        joinLabel
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
      )}

      {showRules && rules && (
        <RulesModal
          title={rules.title || rulesLabel}
          sections={rules.sections || []}
          onClose={() => setShowRules(false)}
        />
      )}

      {after}
      </DailyLossGuard>
  );
}

/**
 * Full lobby page — page chrome + the shared lobby content.
 */
export default function PvpLobbyPage(props) {
  const quickQueueReadinessBody = props.quickQueueReadinessBody;
  const quickQueue = usePlatformQuickQueue({ readinessBody: quickQueueReadinessBody });
  // Same rule as the lobby itself: on the portal surface the page loses the
  // site's footer (outbound links) and the navbar's top offset.
  const pathname = usePathname();
  const practiceMode =
    props.practiceOnly === undefined ? isPortalPlayPath(pathname) : Boolean(props.practiceOnly);
  return (
    <div
      className={`min-h-screen overflow-x-clip px-4 pb-24 text-white sm:px-6 md:pb-8 ${
        practiceMode ? "pt-4" : "pt-20"
      } ${PALETTE.page}`}
    >
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-4 max-w-6xl sm:mt-8">
        <PvpLobby {...props} quickQueue={props.quickQueue ? { ...quickQueue, ...props.quickQueue } : { ...quickQueue, preferences: props.quickQueuePreferences }} />
        {!practiceMode && <Footer />}
      </div>
    </div>
  );
}
