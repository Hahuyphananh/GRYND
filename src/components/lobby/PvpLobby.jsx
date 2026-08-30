"use client";

// src/components/lobby/PvpLobby.jsx
//
// Shared lobby for the casino's 1v1 PvP games. It reproduces the
// Blackjack PvP lobby LAYOUT (balance strip → stake picker + Play →
// escrow note in a single card, then an "Open Lobbies" list card)
// but styled with the Farkle lobby COLOR SCHEME (amber + cyan accents
// on a dark purple-to-navy gradient).
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
// game lobby now looks like the same casino.

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import NavigationBar from "../navigation-bar";
import Footer from "../Footer";
import MatchWaiting from "./MatchWaiting";
import { usePlatformQuickQueue } from "./PlatformQuickQueue";
import DailyLossGuard from "../DailyLossGuard";
import {
  IconTrophy,
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

// Farkle palette tokens — keep the accents consistent across games.
const PALETTE = {
  page: "bg-gradient-to-b from-[#0a0118] to-[#061b3d]",
  card: "border-amber-700/60 bg-black/40",
  title:
    "text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-500 drop-shadow-[0_0_18px_rgba(251,191,36,0.5)]",
  chipActive:
    "border-amber-400 bg-amber-500/20 text-amber-300 shadow-[0_0_15px_rgba(251,191,36,0.3)]",
  chipIdle:
    "border-gray-600 bg-gray-800/50 text-gray-400 hover:border-amber-600/50 hover:text-amber-200",
  play:
    "border-b-4 border-amber-700 bg-amber-500 text-black hover:brightness-110 active:translate-y-[2px] shadow-[0_0_25px_rgba(251,191,36,0.4)]",
  vsAi:
    "border-b-4 border-cyan-700 bg-cyan-500 text-black hover:brightness-110 active:translate-y-[2px] shadow-[0_0_25px_rgba(34,211,238,0.4)]",
  sectionTitle: "text-cyan-300",
  join: "bg-cyan-500 text-black hover:bg-cyan-400",
  row: "border-cyan-700/30 bg-slate-900/80 hover:border-cyan-500/50",
};

function formatBalance(balance) {
  if (balance === null || balance === undefined) return "…";
  return Number(balance).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Responsible-play guard: before a large wager is placed, ask the player to
 * confirm. Triggers when the stake is >= 10,000 tokens or > 10% of their
 * balance — the audit's recommended thresholds. Returns true to proceed.
 */
export function confirmLargeStake(stake, balance) {
  const amount = Number(stake);
  if (!Number.isFinite(amount) || amount <= 0) return true;
  const bal = Number(balance);
  const isLargeAbsolute = amount >= 10000;
  const isLargeVsBalance = Number.isFinite(bal) && bal > 0 && amount > bal * 0.1;
  if (!isLargeAbsolute && !isLargeVsBalance) return true;
  return window.confirm(
    `You're about to wager ${amount.toLocaleString()} tokens — that's ${
      isLargeVsBalance ? "more than 10% of your balance" : "a large amount"
    }. Continue?`,
  );
}

/**
 * RulesModal — a "How to Play" overlay in the farkle palette. Each
 * section is { heading, body } where body may be JSX. Shared by every
 * game lobby so the rules popup looks identical across the casino.
 */
export function RulesModal({ title = "How to Play", sections = [], onClose }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 20 }}
        transition={{ type: "spring", stiffness: 300, damping: 25 }}
        className="relative w-full max-w-lg max-h-[88vh] overflow-hidden rounded-3xl border-2 border-amber-700/60 bg-gradient-to-b from-[#12042a] to-[#0a0118] shadow-[0_0_60px_rgba(251,191,36,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent" />

        <div className="relative flex items-center justify-between px-6 pt-6 pb-4 border-b border-amber-700/30">
          <h2 className="flex items-center gap-2 text-2xl font-black text-amber-300">
            <IconBook size={22} /> {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close rules"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-gray-500/30 text-gray-400 transition-all hover:border-amber-500/50 hover:text-white hover:bg-amber-500/10"
          >
            <IconX size={16} />
          </button>
        </div>

        <div
          role="region"
          aria-label="Open games"
          tabIndex={0}
          className="relative max-h-[calc(88vh-140px)] space-y-4 overflow-y-auto px-6 py-5"
        >
          {sections.map((s, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.05, duration: 0.25 }}
              className="rounded-2xl border border-cyan-700/30 bg-black/40 p-4"
            >
              <h3 className="mb-1.5 flex items-center gap-2 text-sm font-bold text-amber-300">
                <span className="text-cyan-300/70">{i + 1}.</span> {s.heading}
              </h3>
              <div className="text-sm leading-relaxed text-white/75">{s.body}</div>
            </motion.div>
          ))}
        </div>

        <div className="relative px-6 py-4 border-t border-amber-700/30">
          <button
            onClick={onClose}
            className="w-full py-3 rounded-xl font-bold text-sm bg-amber-500 border-b-4 border-amber-700 text-black shadow-[0_0_20px_rgba(251,191,36,0.4)] hover:brightness-110 transition-all duration-300"
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
export function PvpLobby({
  // identity
  title,
  subtitle,
  icon = null,
  // rules (How to Play modal at the top of the lobby)
  rules = null,
  rulesLabel = "How to Play",
  // first-visit auto-open key (per-game, e.g. "lane-runner")
  rulesKey = null,
  // balance
  balance = null,
  // stake
  stake,
  onStakeChange,
  stakeOptions = [],
  stakeMin = 1,
  // main actions
  busy = false,
  onPlay,
  playLabel = "Play",
  playBusyLabel = "Finding match…",
  canPlay = true,
  vsAi = null, // { label, onClick, disabled, busy }
  escrowNote = null,
  extraActions = null,
  // game-specific context line shown under the searching overlay title
  // (e.g. "Pairing you with a player on the same stake…")
  waitingSubtitle = null,
  // error
  error = null,
  // open lobbies
  lobbies = [],
  lobbyEmptyText = "No open lobbies yet. Be the first to make one.",
  lobbyKey = (l) => l?.id,
  lobbyTitle = (l) => <>Lobby #{l?.id}</>,
  lobbyMeta = null,
  onJoin,
  joinBusyId = null,
  joinLabel = "Join",
  onRefresh,
  historyHref = null,
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

  const stakeInputMax = balance === null ? undefined : balance;
  const filteredLobbies = myOpenId !== null && myOpenId !== undefined
    ? lobbies.filter((l) => l?.id !== myOpenId)
    : lobbies;

  return (
    <DailyLossGuard>
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

      {title && (
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1
            className={`flex items-center justify-center gap-3 text-center text-3xl font-extrabold tracking-wide sm:text-4xl ${PALETTE.title}`}
          >
            {icon}
            <span>{title}</span>
          </h1>
        </motion.div>
      )}
      {subtitle && (
        <p className="mx-auto mb-5 mt-2 max-w-2xl text-center text-sm text-white/60">
          {subtitle}
        </p>
      )}

      {/* How to Play — rules modal button at the top of the lobby */}
      {rules && (
        <div className="mb-6 text-center">
          <button
            type="button"
            onClick={() => setShowRules(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-300 transition-all duration-300 hover:bg-amber-500/20 hover:scale-105 shadow-[0_0_14px_rgba(251,191,36,0.15)]"
          >
            <IconBook size={15} /> {rulesLabel}
          </button>
        </div>
      )}
      {showRules && rules && (
        <RulesModal
          title={rules.title || rulesLabel}
          sections={rules.sections || []}
          onClose={() => setShowRules(false)}
        />
      )}

      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className={`rounded-2xl border p-6 shadow-[0_0_30px_rgba(251,191,36,0.12)] backdrop-blur-xl ${PALETTE.card}`}
      >
        <div className="mb-5 text-center text-sm">
          <span className="mr-2 text-[11px] uppercase tracking-widest text-white/55">
            Tokens
          </span>
          <span className="text-lg font-bold text-yellow-300">
            {formatBalance(balance)}
          </span>
        </div>

        {/* Your own open match notification */}
        <AnimatePresence>
          {myOpenId !== null && myOpenId !== undefined && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm"
            >
              <span className="flex items-center gap-2 text-amber-200">
                <LoadingDotsIcon className="h-4 w-4 animate-pulse text-amber-200" />
                Your open lobby #{myOpenId} is waiting for an opponent…
              </span>
              <div className="flex items-center gap-2">
                {onResume && (
                  <button
                    onClick={() => onResume(myOpenId)}
                    className="rounded-lg border-b-2 border-amber-800 bg-amber-400 px-3 py-1.5 text-xs font-bold text-black transition hover:bg-amber-300"
                  >
                    Resume
                  </button>
                )}
                {onCancel && (
                  <button
                    onClick={() => onCancel(myOpenId)}
                    disabled={cancelling}
                    className="rounded-lg border border-red-500/30 bg-red-500/20 px-3 py-1.5 text-xs font-bold text-red-200 transition hover:bg-red-500/30 disabled:opacity-50"
                  >
                    {cancelling ? "Cancelling…" : "Cancel"}
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid items-end gap-3 md:grid-cols-[1.1fr_auto_1fr]">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-white/60">
              Wager
            </label>
            {stakeOptions.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {stakeOptions.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => onStakeChange?.(v)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${
                      stake === v ? PALETTE.chipActive : PALETTE.chipIdle
                    }`}
                  >
                    {Number(v).toLocaleString()}
                  </button>
                ))}
              </div>
            )}
            <input
              type="number"
              min={stakeMin}
              max={stakeInputMax}
              value={stake}
              aria-label="Wager amount"
              onChange={(e) =>
                onStakeChange?.(Math.max(stakeMin, Number(e.target.value) || 0))
              }
              className="mt-1.5 w-full rounded-md border border-amber-600/50 bg-[#020617] px-2 py-1.5 text-xs text-white outline-none focus:border-amber-400"
            />
          </div>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => {
                if (!confirmLargeStake(stake, balance)) return;
                onPlay?.();
              }}
              disabled={!canPlay || busy}
              className={`inline-flex items-center justify-center gap-2 rounded-xl border-b-4 p-3 text-base font-extrabold transition hover:scale-105 active:scale-95 disabled:opacity-50 disabled:hover:scale-100 ${PALETTE.play}`}
            >
              {busy ? (
                <>
                  <LoadingDotsIcon className="h-4 w-4 animate-pulse text-black" />
                  <span>{playBusyLabel}</span>
                </>
              ) : (
                <>
                  <span>{Number(stake).toLocaleString()}</span>
                  <CoinIcon className="h-5 w-5 text-amber-900" />
                  <span> · {playLabel}</span>
                </>
              )}
            </button>
            {vsAi && (
              <button
                type="button"
                onClick={vsAi.onClick}
                disabled={vsAi.disabled || busy}
                className={`inline-flex items-center justify-center gap-2 rounded-xl border-b-4 p-2.5 text-sm font-bold transition hover:brightness-110 disabled:opacity-50 ${PALETTE.vsAi}`}
              >
                <IconRobot size={17} className="text-black/70" />
                {vsAi.busy ? "Starting…" : vsAi.label}
                {vsAi.badge && (
                  <span className="rounded-full bg-black/15 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-black/80">
                    {vsAi.badge}
                  </span>
                )}
              </button>
            )}
            {extraActions}
          </div>

          <div className="text-xs leading-relaxed text-white/55">
            {escrowNote}
          </div>
        </div>

        {quickQueue && (
          <div className="mt-5 rounded-xl border border-cyan-500/30 bg-cyan-950/25 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-bold text-cyan-200">Platform Quick Queue</p>
                <p className="mt-1 text-xs text-white/60">
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
                className={`rounded-xl border-b-4 px-4 py-2.5 text-sm font-extrabold transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 ${
                  quickQueue.ready
                    ? "border-emerald-800 bg-emerald-400 text-black"
                    : "border-cyan-800 bg-cyan-400 text-black"
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
            {quickQueue.error && (
              <p className="mt-2 text-xs text-red-200">{quickQueue.error}</p>
            )}
          </div>
        )}

        {children}

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200">
            <IconAlertTriangle className="h-4 w-4 flex-shrink-0 text-red-300" />
            <span>{error}</span>
          </div>
        )}
      </motion.div>

      <div
        className={`mt-6 rounded-2xl border p-5 shadow-[0_0_22px_rgba(251,191,36,0.1)] ${PALETTE.card}`}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2
            className={`flex items-center gap-2 text-lg font-bold uppercase tracking-wider ${PALETTE.sectionTitle}`}
          >
            <IconTrophy className="h-4 w-4" />
            Open Lobbies
          </h2>
          <div className="flex items-center gap-2">
            {historyHref && (
              <Link
                href={historyHref}
                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-500/20"
              >
                <IconNotebook className="h-3.5 w-3.5" />
                History
              </Link>
            )}
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition hover:brightness-110 ${PALETTE.join}`}
              >
                <IconRefresh className="h-3.5 w-3.5" />
                Refresh
              </button>
            )}
          </div>
        </div>
        {filteredLobbies.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-white/60">
            <IconDeviceGamepad2 className="h-4 w-4 text-white/40" />
            <span>{lobbyEmptyText}</span>
          </div>
        ) : (
          <div className="space-y-2.5">
            {filteredLobbies.map((l) => {
              const key = lobbyKey(l);
              return (
                <div
                  key={key}
                  className={`flex items-center justify-between rounded-xl border p-3 transition ${PALETTE.row}`}
                >
                  <div>
                    <p className="text-sm font-semibold">{lobbyTitle(l)}</p>
                    {lobbyMeta && (
                      <p className="mt-0.5 text-xs text-white/60">
                        {lobbyMeta(l)}
                      </p>
                    )}
                  </div>
                  {onJoin && (
                    <button
                      type="button"
                      onClick={() => onJoin(l)}
                      disabled={busy || joinBusyId === key}
                      className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-bold transition hover:brightness-110 disabled:bg-cyan-500/30 disabled:text-white/60 ${PALETTE.join}`}
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
      </div>

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
  return (
    <div
      className={`min-h-screen overflow-x-clip px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8 ${PALETTE.page}`}
    >
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-4 max-w-5xl sm:mt-8">
        <PvpLobby {...props} quickQueue={props.quickQueue ? { ...quickQueue, ...props.quickQueue } : { ...quickQueue, preferences: props.quickQueuePreferences }} />
        <Footer />
      </div>
    </div>
  );
}
