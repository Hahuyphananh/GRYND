"use client";

// src/app/casino/blackjack/[matchId]/page.tsx
//
// LIVE match view for the Blackjack PvP system.
//
// What this page does:
//   • Polls /api/blackjack-pvp/match/[matchId] every 1.5s for state.
//   • Subscribes to `lobby:updated` Socket.IO events on the per-match
//     room so opponent actions appear within ~50ms instead of waiting
//     for the next poll.
//   • Renders ONLY the viewer's own cards + score + state. The
//     opponent's section always shows the placeholder text
//     "Opponent Playing…" — their cards, score, state, and
//     Swap/Hold status are NEVER revealed to the viewer, even at
//     round-end or match-end.
//
// What this page intentionally does NOT do:
//   • No split, no double, no insurance — out of scope per spec.
//   • No dealer presence — eliminated entirely.
//   • No opponent-card reveal at any time. The round-result modal
//     reveals MY cards + an abstract "won/lost" outcome but never
//     the opponent's actual values.
//   • No client-side round resolution or winner decision — the
//     server is authoritative; the page is a thin renderer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";
import { usePostHog } from "posthog-js/react";
import NavigationBar from "../../../../components/navigation-bar";
import BlackjackCardBack from "../../../../components/BlackjackCardBack";
import {
  playCardDraw,
  playVictory,
  playDefeat,
} from "../../../../lib/gameAudio";
import {
  isRedSuit,
  SWAP_LIMIT_PER_ROUND,
  HOLD_LIMIT_PER_ROUND,
  BETWEEN_ROUNDS_SECONDS,
  TOTAL_ROUNDS,
} from "../../../../lib/blackjack-pvp/constants";
import { useTranslation } from "../../../../hooks/useTranslation";
import { useSocket } from "../../../../context/SocketProvider";
import {
  BLACKJACK_PVP_MATCH_UPDATED,
  blackjackPvpMatchRoom,
} from "../../../../lib/blackjack-pvp/rooms";

// ── Types ────────────────────────────────────────────────────────────
type Card = { suit: string; value: string };

type SeatActions = {
  swapsUsed: number;
  holdsUsed: number;
  heldCard: Card | null;
  heldResolved: string | null;
};

type MatchState = {
  id: number;
  player1Id: string;
  player2Id: string | null;
  stakeAmount: number;
  status: string;
  roundNumber: number;
  roundsWonPlayer1: number;
  roundsWonPlayer2: number;
  player1Hand: Card[];
  player2Hand: Card[];
  player1State: string;
  player2State: string;
  // Wire-only computed booleans (Prompt 9 schema refactor): true
  // iff the per-seat `state !== 'playing'`. The opponent's standing
  // is collapsed to a boolean on the wire so the UI can't infer
  // their strategy.
  player1Standing: boolean;
  player2Standing: boolean;
  viewerIsPlayer1: boolean;
  roundDeadline: string | null;
  // Pre-refactor: winnerId. Renamed to `winner` per Prompt 9 spec;
  // the column still stores the userId of the winning player.
  winner: string | null;
  result: string | null;
  prizePaid: number;
  houseFee: number;
  roundTimer: number;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  player1UsedSwap: number;
  player2UsedSwap: number;
  player1UsedFreeze: number;
  player2UsedFreeze: number;
  player1FrozenCard: Card | null;
  player2FrozenCard: Card | null;
  player1HeldResolved: string | null;
  player2HeldResolved: string | null;
};

type RoundRow = {
  id: number;
  roundNumber: number;
  // Round-end reveal: the API returns BOTH hands + BOTH scores +
  // BOTH end-state strings from the persisted `blackjack_pvp_rounds`
  // row so the round-result screen can compare them fairly.
  player1Hand: Card[];
  player2Hand: Card[];
  player1Score: number;
  player2Score: number;
  player1State: string;
  player2State: string;
  roundWinner: string | null;
  viewerWonThisRound: boolean;
};

type TFn = (key: string, fallback?: string) => string;

// ── Card face component (kept identical to the old solo-blackjack so
// the SVG / colour treatment is preserved) ──────────────────────────
const CardFace: React.FC<{
  card: Card;
  small?: boolean;
  rotateY?: boolean;
  fade?: boolean;
}> = ({ card, small, rotateY, fade }) => {
  const red = isRedSuit(card.suit);
  const size = small ? "h-24 w-16 text-base" : "h-28 w-20 text-xl";
  const pipSize = small ? "text-xs" : "text-sm";
  return (
    <div
      className={`${size} bg-gradient-to-br from-white to-gray-100 rounded-lg shadow-lg border border-gray-300 flex flex-col justify-between p-1.5 select-none relative overflow-hidden ${
        fade ? "opacity-80" : ""
      }`}
      style={{ transform: rotateY ? "rotateY(180deg)" : undefined }}
    >
      <div
        className={`flex flex-col items-start leading-tight ${pipSize} font-bold`}
        style={{ color: red ? "#c0392b" : "#1a1a2e" }}
      >
        <span>{card.value}</span>
        <span className={small ? "text-[10px]" : "text-xs"}>{card.suit}</span>
      </div>
      <div
        className="absolute inset-0 flex items-center justify-center opacity-20 pointer-events-none"
        style={{ color: red ? "#c0392b" : "#1a1a2e" }}
      >
        <span className={small ? "text-4xl" : "text-5xl"}>{card.suit}</span>
      </div>
      <div
        className={`flex flex-col items-end leading-tight ${pipSize} font-bold rotate-180`}
        style={{ color: red ? "#c0392b" : "#1a1a2e" }}
      >
        <span>{card.value}</span>
        <span className={small ? "text-[10px]" : "text-xs"}>
          {card.suit}
        </span>
      </div>
    </div>
  );
};

// Hidden opponent card placeholder — count visible (matches what's in
// the API's scrubbed hand), values never revealed.
const HiddenOppCard: React.FC = () => (
  <motion.div
    initial={{ y: -40, opacity: 0 }}
    animate={{ y: 0, opacity: 1 }}
    transition={{ duration: 0.35 }}
  >
    <BlackjackCardBack />
  </motion.div>
);

// ── Page ─────────────────────────────────────────────────────────────
export default function BlackjackPvpMatchPage({
  params,
}: {
  params: { matchId: string };
}) {
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();
  const { t } = useTranslation();

  const matchId = Number(params?.matchId);
  const isValidMatchId = Number.isFinite(matchId);

  const [match, setMatch] = useState<MatchState | null>(null);
  const [rounds, setRounds] = useState<RoundRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [roundResultShownFor, setRoundResultShownFor] = useState<number | null>(
    null,
  );
  const victoryCelebratedRef = useRef(false);
  // Tracks which round numbers the user has already acknowledged in a
  // round-result modal. Without this, the modal would re-open on every
  // poll (because the latest-round-vs-shownFor check flips back to true
  // the moment the user dismisses).
  const acknowledgedRoundsRef = useRef<Set<number>>(new Set());
  const lastSeenMatchIdRef = useRef<number | null>(null);

  // Memo: my hand + opponent hand derived from viewerIsPlayer1.
  const viewerIsPlayer1 = Boolean(match?.viewerIsPlayer1);
  const myHand = useMemo<Card[]>(() => {
    if (!match) return [];
    return viewerIsPlayer1 ? match.player1Hand : match.player2Hand;
  }, [match, viewerIsPlayer1]);
  const oppHand = useMemo<Card[]>(() => {
    if (!match) return [];
    return viewerIsPlayer1 ? match.player2Hand : match.player1Hand;
  }, [match, viewerIsPlayer1]);
  const myState = match
    ? viewerIsPlayer1
      ? match.player1State
      : match.player2State
    : "playing";
  // Prompt 9 schema refactor: derive the spec's `player{N}Standing`
  // wire boolean into a local memo so the action gates can lean on a
  // single boolean instead of tautologically comparing state strings.
  // The opponent's standing wire value is already collapsed to a
  // boolean on the server side during active play so we don't keep
  // an `oppStanding` mirror here — it's noise the page doesn't need.
  const myStanding = match
    ? viewerIsPlayer1
      ? Boolean(match.player1Standing)
      : Boolean(match.player2Standing)
    : false;
  const myActions: SeatActions = match
    ? viewerIsPlayer1
      ? {
          swapsUsed: match.player1UsedSwap,
          holdsUsed: match.player1UsedFreeze,
          heldCard: match.player1FrozenCard,
          heldResolved: match.player1HeldResolved,
        }
      : {
          swapsUsed: match.player2UsedSwap,
          holdsUsed: match.player2UsedFreeze,
          heldCard: match.player2FrozenCard,
          heldResolved: match.player2HeldResolved,
        }
    : {
        swapsUsed: 0,
        holdsUsed: 0,
        heldCard: null,
        heldResolved: null,
      };

  // Score (only the viewer's own — opponent score is never computed
  // client-side because the opponent's hand values are scrubbed).
  const myScore = useMemo(() => calcHandValue(myHand), [myHand]);

  // ── Fetch + poll ──────────────────────────────────────────────────
  const fetchStatus = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!isValidMatchId) return;
      try {
        const res = await fetch(`/api/blackjack-pvp/match/${matchId}`, {
          cache: "no-store",
          credentials: "include",
        });
        if (res.status === 401) {
          router.push("/sign-in?redirect_url=/casino/blackjack");
          return;
        }
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        const data = await res.json();
        if (!data?.success) {
          if (!opts?.silent) setErrorMsg(data?.error || "Match unavailable");
          return;
        }
        setErrorMsg(null);
        setForbidden(false);
        const next = data.data.match as MatchState;
        const prevStatus = match?.status;
        setMatch(next);
        setRounds(data.data.rounds || []);

        if (
          prevStatus === "ready" &&
          (next.status === "round_1" ||
            next.status === "round_2" ||
            next.status === "round_3") &&
          myHand.length === 0 &&
          next.player1Hand.length > 0
        ) {
          playCardDraw();
        }

        posthog?.capture(`blackjack_pvp_match_${next.status}`, {
          match_id: matchId,
          round: next.roundNumber,
        });
      } catch (e) {
        if (!opts?.silent) setErrorMsg("Network error");
      }
    },
    [isValidMatchId, matchId, match?.status, myHand.length, posthog, router],
  );

  // Initial fetch + 1.5s poll.
  useEffect(() => {
    if (!isSignedIn) {
      router.push("/sign-in?redirect_url=/casino/blackjack");
      return;
    }
    if (!isValidMatchId) {
      router.push("/casino/blackjack");
      return;
    }
    if (lastSeenMatchIdRef.current !== matchId) {
      acknowledgedRoundsRef.current = new Set();
      lastSeenMatchIdRef.current = matchId;
    }
    fetchStatus({ silent: true });
    const interval = setInterval(() => fetchStatus({ silent: true }), 1500);
    return () => clearInterval(interval);
  }, [isSignedIn, isValidMatchId, matchId, router, fetchStatus]);

  // Socket fanout: when the OTHER player makes an action, the
  // realtime-server relays a `lobby:updated` event into the per-match
  // room, and we re-fetch. Mirrors roulette-pvp's pattern.
  useEffect(() => {
    if (!socket || !isValidMatchId) return;
    const refresh = () => fetchStatus({ silent: true });
    socket.emit("join_room", { roomId: blackjackPvpMatchRoom(matchId) });
    socket.on(BLACKJACK_PVP_MATCH_UPDATED, refresh);
    return () => {
      socket.emit("leave_room", { roomId: blackjackPvpMatchRoom(matchId) });
      socket.off(BLACKJACK_PVP_MATCH_UPDATED, refresh);
    };
  }, [socket, matchId, isValidMatchId, fetchStatus]);

  // ── Player actions ────────────────────────────────────────────────
  const sendAction = useCallback(
    async (
      action: "hit" | "stand" | "swap" | "hold" | "use_held",
      payload?: Record<string, unknown>,
    ) => {
      if (!match) return;
      if (
        match.status !== "round_1" &&
        match.status !== "round_2" &&
        match.status !== "round_3"
      )
        return;
      if (submitting) return;
      setSubmitting(true);
      setErrorMsg(null);
      try {
        const res = await fetch(
          `/api/blackjack-pvp/match/${matchId}/action`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ action, payload }),
          },
        );
        const data = await res.json();
        if (!res.ok || !data.success) {
          setErrorMsg(data?.error || "Action rejected");
          return;
        }
        if (action === "hit" && !data.data.justResolved) {
          playCardDraw();
        }
        if (action === "stand") playCardDraw();
        await fetchStatus({ silent: true });
        socket?.emit("room_event", {
          roomId: blackjackPvpMatchRoom(matchId),
          event: BLACKJACK_PVP_MATCH_UPDATED,
        });
      } catch (e) {
        setErrorMsg("Network error");
      } finally {
        setSubmitting(false);
      }
    },
    [match, matchId, submitting, socket, fetchStatus],
  );

  // ── Round-result modal trigger ────────────────────────────────────
  useEffect(() => {
    if (!match || rounds.length === 0) {
      setRoundResultShownFor(null);
      return;
    }
    if (match.status === "finished" || match.status === "cancelled") {
      setRoundResultShownFor(null);
      return;
    }
    for (let i = rounds.length - 1; i >= 0; i--) {
      const n = rounds[i].roundNumber;
      if (!acknowledgedRoundsRef.current.has(n)) {
        acknowledgedRoundsRef.current.add(n);
        setRoundResultShownFor(n);
        return;
      }
    }
    setRoundResultShownFor(null);
  }, [match?.status, rounds, match]);

  // Confetti for match-end victory — fire once when status flips to
  // `finished` and the viewer is the winner.
  useEffect(() => {
    if (
      match?.status === "finished" &&
      match.winner &&
      user?.id === match.winner &&
      !victoryCelebratedRef.current
    ) {
      victoryCelebratedRef.current = true;
      playVictory();
      confetti({
        particleCount: 60,
        spread: 70,
        origin: { y: 0.6 },
        colors: ["#FFD700", "#FFA500", "#FFFFFF"],
      });
      setTimeout(
        () =>
          confetti({
            particleCount: 30,
            spread: 50,
            origin: { y: 0.5 },
            colors: ["#FFD700", "#FFFFFF"],
          }),
        300,
      );
    }
    if (
      match?.status === "finished" &&
      match.winner &&
      user?.id !== match.winner &&
      match.result !== "draw" &&
      !victoryCelebratedRef.current
    ) {
      victoryCelebratedRef.current = true;
      playDefeat();
    }
    if (match?.status === "finished" && match.result === "draw") {
      victoryCelebratedRef.current = true;
    }
  }, [match, user?.id]);

  // ── Derived flags for action availability ─────────────────────────
  const isMyTurn =
    match?.status === "round_1" ||
    match?.status === "round_2" ||
    match?.status === "round_3";

  const mySeatLabel = viewerIsPlayer1
    ? t("blackjackPvp.seat.player1", "Joueur 1")
    : t("blackjackPvp.seat.player2", "Joueur 2");
  const oppSeatLabel = viewerIsPlayer1
    ? t("blackjackPvp.seat.opponent", "Adversaire")
    : t("blackjackPvp.seat.opponent", "Adversaire");

  // Action gates (Prompt 9): switched from `myState === "playing"`
  // string comparisons to `!myStanding` for cleaner semantics. The
  // standing wire boolean is derived from the server's player{N}_state
  // enum, so the action-disabled invariant is enforced by the same
  // server-authoritative rule that gates the engine's recordAction.
  const canSwap =
    isMyTurn &&
    !myStanding &&
    myHand.length >= 2 &&
    (myActions.swapsUsed ?? 0) < SWAP_LIMIT_PER_ROUND;
  const canHold =
    isMyTurn &&
    !myStanding &&
    myHand.length >= 2 &&
    (myActions.holdsUsed ?? 0) < HOLD_LIMIT_PER_ROUND &&
    !myActions.heldCard;
  // Per Prompt 7: once a seat leaves `playing` (stood or busted)
  // no further gameplay actions are allowed — including Use-Held.
  // The hold-then-stand post-resolution path is intentionally gone: a
  // player who holds must add or discard BEFORE standing.
  const canUseHeldAdd =
    isMyTurn &&
    !myStanding &&
    Boolean(myActions.heldCard) &&
    !myActions.heldResolved;
  const canUseHeldDiscard =
    isMyTurn &&
    !myStanding &&
    Boolean(myActions.heldCard) &&
    !myActions.heldResolved;
  const canHit = isMyTurn && !myStanding && myScore < 21;
  const canStand = isMyTurn && !myStanding;

  // ── Render: header / status banner / 403 / not-found ──────────────
  const statusLabel = (() => {
    if (!match) return t("blackjackPvp.status.loading", "Chargement…");
    switch (match.status) {
      case "waiting":
        return t(
          "blackjackPvp.status.waiting",
          "En attente d'un adversaire…",
        );
      case "ready":
        return t("blackjackPvp.status.ready", "Préparez-vous…");
      case "between_rounds":
        return t(
          "blackjackPvp.status.betweenRounds",
          "Manche suivante imminente…",
        );
      // Round N/3 is rendered by <GameTableCenter /> for every active
      // round status. The status banner stays intentionally lean
      // during play, otherwise the same round number appears in two
      // spots (banner + scoreboard chip).
      case "round_1":
      case "round_2":
      case "round_3":
        return t("blackjackPvp.status.activePlay", "En jeu");
      case "finished":
        if (match.result === "draw")
          return t(
            "blackjackPvp.status.finishedDraw",
            "Égalité — mise remboursée",
          );
        if (match.winner === user?.id)
          return t("blackjackPvp.status.finishedWin", "Vous avez gagné !");
        return t("blackjackPvp.status.finishedLose", "Vous avez perdu");
      case "cancelled":
        return t("blackjackPvp.status.cancelled", "Partie annulée");
      default:
        return match.status;
    }
  })();

  if (forbidden) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-[#001933] to-[#000d1a] text-white">
        <div className="bg-[#0b224f]/70 border border-red-300/30 rounded-2xl p-6 max-w-md text-center">
          <h2 className="text-xl font-bold text-red-200">
            {t(
              "blackjackPvp.forbidden.title",
              "Vous n'êtes pas dans cette partie.",
            )}
          </h2>
          <p className="text-sm text-white/60 mt-2">
            {t(
              "blackjackPvp.forbidden.desc",
              "Vérifiez l'identifiant de la partie ou retournez au lobby.",
            )}
          </p>
          <button
            onClick={() => router.push("/casino/blackjack")}
            className="mt-4 px-4 py-2 rounded-lg bg-yellow-300 text-[#001933] font-bold text-sm hover:bg-yellow-200 transition"
          >
            {t("blackjackPvp.lobby.back", "Retour au lobby")}
          </button>
        </div>
      </div>
    );
  }

  if (!isValidMatchId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#001933] to-[#000d1a] text-white">
        <p className="text-sm text-white/60">
          {t(
            "blackjackPvp.invalidId",
            "Identifiant de partie invalide…",
          )}
        </p>
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────────────
  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] pb-24 pt-20 text-white md:pb-8">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto max-w-5xl px-3 py-4 sm:px-4 sm:py-6">
        {/* Header */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl sm:text-3xl font-bold text-[#FFD700] drop-shadow-[0_0_10px_rgba(255,215,0,0.4)]">
            {t("blackjackPvp.title", "🃏 Blackjack PvP")}
          </h1>
          <span className="px-4 py-1.5 bg-[#FFD700]/15 border border-[#FFD700]/40 text-[#fffec7] rounded-full font-extrabold text-sm shadow-[0_0_10px_rgba(255,215,0,0.3)]">
            {t("blackjackPvp.stake", "Mise : {amount}").replace(
              "{amount}",
              Number(match?.stakeAmount ?? 0).toLocaleString(),
            )}
          </span>
        </div>

        {errorMsg && (
          <div className="mb-3 bg-red-500/10 border border-red-500/30 text-red-400 p-2 rounded text-sm text-center">
            {errorMsg}
          </div>
        )}

        <div className="rounded-2xl border border-[#FFD700]/25 bg-gradient-to-br from-[#001933]/90 via-[#00111f]/90 to-[#000814]/90 shadow-[0_0_30px_rgba(255,215,0,0.12)] p-4 sm:p-6">
          {/* Status banner — transient status only (round indicator
              lives in the GameTableCenter below). */}
          <div className="text-center mb-3">
            <motion.h2
              key={match?.status ?? "loading"}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-[#FFD700] text-base sm:text-lg font-bold"
            >
              {statusLabel}
            </motion.h2>
          </div>

          {/* ▶ TOP SECTION — Opponent
              Always face-down + localized "Opponent Playing…"
              placeholder text. Never reveals anything else. */}
          <OpponentHand
            t={t}
            label={oppSeatLabel}
            hand={oppHand}
            isMatchFinished={match?.status === "finished"}
          />

          {/* ▶ MIDDLE SECTION — Game table
              Round scoreboard + Round N/3 chip (Player | Round |
              Opponent). Hidden during the between-rounds transition
              because that screen overlays the table instead. */}
          <GameTableCenter
            t={t}
            viewerIsPlayer1={viewerIsPlayer1}
            status={match?.status || "waiting"}
            roundNumber={
              match?.roundNumber && match.roundNumber >= 1
                ? match.roundNumber
                : 1
            }
            totalRounds={TOTAL_ROUNDS}
            myRounds={
              viewerIsPlayer1
                ? Number(match?.roundsWonPlayer1 || 0)
                : Number(match?.roundsWonPlayer2 || 0)
            }
            oppRounds={
              viewerIsPlayer1
                ? Number(match?.roundsWonPlayer2 || 0)
                : Number(match?.roundsWonPlayer1 || 0)
            }
            mySeatLabel={mySeatLabel}
            oppSeatLabel={oppSeatLabel}
          />

          {/* ▶ BOTTOM SECTION — You
              Face-up cards + my score (with bust / stood states
              surfaced through the same MyHand component). */}
          <MyHand
            t={t}
            label={mySeatLabel}
            hand={myHand}
            myState={myState}
            score={myScore}
          />

          {/* Held-card preview (so the player can see what's on hold
             and decide add vs discard). */}
          {myActions.heldCard && (
            <HeldCardPreview
              t={t}
              card={myActions.heldCard}
              resolved={myActions.heldResolved}
            />
          )}

          {/* Result text — note `match.result` is 'player1' |
             'player2' | 'draw' | null; the 'finished' sentinel lives
             on `match.status`. */}
          {match?.status === "finished" && (
            <div
              className={`text-center text-lg font-bold mt-3 ${
                match.winner === user?.id
                  ? "text-amber-300"
                  : match.result === "draw"
                  ? "text-yellow-300"
                  : "text-red-300"
              }`}
            >
              {match.winner === user?.id
                ? t("blackjackPvp.result.win", "Victoire !")
                : match.result === "draw"
                ? t(
                    "blackjackPvp.result.draw",
                    "Égalité — votre mise est remboursée.",
                  )
                : t("blackjackPvp.result.lose", "Défaite")}
            </div>
          )}

          {/* Between-rounds transition screen — shows while the
              server is in MATCH_STATUS.BETWEEN_ROUNDS (a 3-second
              buffer between resolved rounds). The active cards are
              deliberately hidden here so the "next round incoming"
              message is unambiguous; the polling loop will surface
              the next round's hands automatically. A "Continue now"
              button lets the player skip the wait. */}
          {match?.status === "between_rounds" && (
            <BetweenRoundsScreen
              t={t}
              matchId={matchId}
              nextRound={Number(match.roundNumber) + 1}
              totalRounds={TOTAL_ROUNDS}
              roundsWonPlayer1={Number(match.roundsWonPlayer1) || 0}
              roundsWonPlayer2={Number(match.roundsWonPlayer2) || 0}
              onAfter={fetchStatus}
            />
          )}

          {/* Action buttons — only during active round. */}
          {isMyTurn && myState === "playing" && (
            <ActionPanel
              t={t}
              submitting={submitting}
              canHit={canHit}
              canStand={canStand}
              canSwap={canSwap}
              canHold={canHold}
              canUseHeldAdd={canUseHeldAdd}
              canUseHeldDiscard={canUseHeldDiscard}
              onHit={() => sendAction("hit")}
              onStand={() => sendAction("stand")}
              onSwap={(idx) => sendAction("swap", { swapIndex: idx })}
              onHold={() => sendAction("hold")}
              onUseHeldAdd={() =>
                sendAction("use_held", { subaction: "add" })
              }
              onUseHeldDiscard={() =>
                sendAction("use_held", { subaction: "discard" })
              }
            />
          )}
          {/* After standing, the hand is locked and the player has
              NO remaining actions. The "en attente de l'adversaire"
              hint below mirrors the busted posture identically so
              the opponent can't tell the two apart without seeing
              the active cards. */}
          {isMyTurn && myState === "stood" && (
            <div className="mt-3 text-center text-xs text-white/55 italic">
              {t(
                "blackjackPvp.lockedAfterStand",
                "Hand locked — both hands reveal when the round ends.",
              )}
            </div>
          )}
          {isMyTurn && myState !== "playing" && (
            <div className="mt-4 text-center text-xs text-white/55">
              {myState === "busted"
                ? t(
                    "blackjackPvp.waitingBusted",
                    "Vous avez sauté (>21). En attente de l'adversaire…",
                  )
                : t(
                    "blackjackPvp.waitingStood",
                    "Vous restez. En attente de l'adversaire…",
                  )}
            </div>
          )}
          {match?.status === "waiting" && (
            <WaitingBanner
              t={t}
              onCancel={async () => {
                await fetch(
                  `/api/blackjack-pvp/match/${matchId}/cancel`,
                  {
                    method: "POST",
                    credentials: "include",
                  },
                );
                socket?.emit("room_event", {
                  roomId: "lobby:blackjack-pvp",
                  event: "lobby:updated",
                });
                router.push("/casino/blackjack");
              }}
              isOwner={match?.player1Id === user?.id}
            />
          )}
          {match?.status === "ready" && (
            <div className="mt-4 text-center text-xs text-cyan-300 font-bold tracking-widest uppercase">
              {t("blackjackPvp.ready", "Manche 1 imminente…")}
            </div>
          )}
        </div>

        {/* Round-by-round history footer — abstract win/loss only;
           opponent cards+score are scrubbed server-side. */}
        {rounds.length > 0 && (
          <div className="mt-4 rounded-xl bg-[#001933]/60 border border-[#FFD700]/15 p-3 text-xs text-[#FFD700]/80">
            <h3 className="text-[#FFD700] font-bold mb-2 text-sm">
              {t("blackjackPvp.historyTitle", "Historique des manches")}
            </h3>
            <div className="space-y-1.5">
              {rounds.map((r) => {
                const myScore = viewerIsPlayer1
                  ? r.player1Score
                  : r.player2Score;
                const oppScore = viewerIsPlayer1
                  ? r.player2Score
                  : r.player1Score;
                const myBusted =
                  (viewerIsPlayer1 ? r.player1State : r.player2State) ===
                  "busted";
                const oppBusted =
                  (viewerIsPlayer1 ? r.player2State : r.player1State) ===
                  "busted";
                const viewerWon = r.viewerWonThisRound === true;
                return (
                  <div
                    key={r.id}
                    className="flex items-center justify-between rounded-lg bg-[#08142f]/60 px-3 py-1.5"
                  >
                    <span>
                      {t(
                        "blackjackPvp.historyRow",
                        "Manche {n} — {me}: {myScore}{meTag} vs {opp}: {oppScore}{oppTag}",
                      )
                        .replace("{n}", String(r.roundNumber))
                        .replace("{me}", mySeatLabel)
                        .replace("{myScore}", String(myScore))
                        .replace(
                          "{meTag}",
                          myBusted
                            ? ` ${t("blackjackPvp.bustTag", "(sauté)")}`
                            : "",
                        )
                        .replace("{opp}", oppSeatLabel)
                        .replace("{oppScore}", String(oppScore))
                        .replace(
                          "{oppTag}",
                          oppBusted
                            ? ` ${t("blackjackPvp.bustTag", "(sauté)")}`
                            : "",
                        )}
                    </span>
                    <span
                      className={
                        r.roundWinner === "draw"
                          ? "text-yellow-300 font-bold"
                          : viewerWon
                          ? "text-green-300 font-bold"
                          : "text-red-300 font-bold"
                      }
                    >
                      {r.roundWinner === "draw"
                        ? t("blackjackPvp.historyDraw", "Égalité")
                        : viewerWon
                        ? t("blackjackPvp.historyWin", "Vous gagnez")
                        : t("blackjackPvp.historyLose", "Vous perdez")}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Round-end reveal modal — shows MY hand + abstract result.
         NEVER reveals opponent cards or score. */}
      <AnimatePresence>
        {roundResultShownFor !== null &&
          (() => {
            const round = rounds.find(
              (r) => r.roundNumber === roundResultShownFor,
            );
            if (!round) return null;
            return (
              <RoundResultModal
                t={t}
                round={round}
                viewerIsPlayer1={viewerIsPlayer1}
                onDismiss={() => setRoundResultShownFor(null)}
              />
            );
          })()}
      </AnimatePresence>

      {/* Match-end modal — once only */}
      <AnimatePresence>
        {match?.status === "finished" && (
          <MatchEndModal
            t={t}
            stake={Number(match.stakeAmount)}
            prizePaid={Number(match.prizePaid)}
            houseFee={Number(match.houseFee)}
            winner={match.winner}
            userId={user?.id ?? null}
            result={match.result}
            onBackToLobby={() => {
              victoryCelebratedRef.current = false;
              acknowledgedRoundsRef.current = new Set();
              router.push("/casino/blackjack");
            }}
          />
        )}
        {match?.status === "cancelled" && (
          <CancelledModal
            t={t}
            onBackToLobby={() => router.push("/casino/blackjack")}
          />
        )}
      </AnimatePresence>

      {/* Animations */}
      <style jsx>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-6px); }
          40% { transform: translateX(6px); }
          60% { transform: translateX(-4px); }
          80% { transform: translateX(4px); }
        }
        .animate-shake { animation: shake 0.4s ease-in-out; }
      `}</style>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────
function OpponentHand({
  t,
  label,
  hand,
  isMatchFinished,
}: {
  t: TFn;
  label: string;
  hand: Card[];
  isMatchFinished: boolean;
}) {
  // By spec the opponent's cards, score, and state are NEVER shown.
  const placeholder = isMatchFinished
    ? t("blackjackPvp.opponentDone", "Adversaire — main cachée")
    : t("blackjackPvp.opponentPlaying", "Adversaire joue…");
  return (
    <div>
      <div className="text-center mb-2">
        <h2 className="text-[#FFD700]/80 text-sm font-semibold">{label}</h2>
        <p className="text-xs mt-0.5 text-[#FFD700]/60 italic">
          {placeholder}
        </p>
      </div>
      <div className="flex justify-center gap-3 mb-1 flex-wrap">
        {hand.length === 0
          ? [0, 1].map((i) => <BlackjackCardBack key={i} />)
          : hand.map((_, i) => <HiddenOppCard key={i} />)}
      </div>
    </div>
  );
}

function MyHand({
  t,
  label,
  hand,
  myState,
  score,
}: {
  t: TFn;
  label: string;
  hand: Card[];
  myState: string;
  score: number;
}) {
  const busted = myState === "busted" && hand.length > 0;
  return (
    <div>
      <div className="text-center mb-2">
        <h2 className="text-[#FFD700] text-sm font-bold">
          {label} ({t("blackjackPvp.you", "vous")})
        </h2>
        {hand.length > 0 && (
          <p
            className={`text-xs mt-0.5 font-bold ${
              busted ? "text-red-400" : "text-[#FFD700]/80"
            }`}
          >
            {busted
              ? `${t("blackjackPvp.bustedPrefix", "Vous avez sauté !")} (${score})`
              : myState === "stood"
              ? `${t("blackjackPvp.stand", "Rester")} (${score} pts)`
              : `${score} pts`}
          </p>
        )}
      </div>
      <div className="flex justify-center gap-3 mb-1 flex-wrap">
        {hand.length === 0 ? (
          [0, 1].map((i) => <BlackjackCardBack key={i} />)
        ) : (
          hand.map((card, i) => (
            <motion.div
              key={i}
              initial={{ y: 60, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.35, delay: i * 0.12 }}
              className={busted ? "animate-shake" : ""}
            >
              <CardFace card={card} />
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}

function HeldCardPreview({
  t,
  card,
  resolved,
}: {
  t: TFn;
  card: Card;
  resolved: string | null;
}) {
  return (
    <div className="mt-3 rounded-lg border border-dashed border-[#FFD700]/40 bg-[#001933]/40 p-3 flex items-center justify-center gap-3 flex-wrap">
      <div className="text-xs uppercase tracking-widest text-[#FFD700]/80 font-bold">
        {t("blackjackPvp.heldReserved", "Carte en réserve")}
      </div>
      <CardFace card={card} small fade />
      {resolved && (
        <div className="text-xs text-yellow-300 font-bold">
          {resolved === "add"
            ? t("blackjackPvp.heldAdded", "(ajoutée à la main)")
            : t("blackjackPvp.heldDiscarded", "(jetée)")}
        </div>
      )}
    </div>
  );
}

function ActionPanel({
  t,
  submitting,
  canHit,
  canStand,
  canSwap,
  canHold,
  canUseHeldAdd,
  canUseHeldDiscard,
  onHit,
  onStand,
  onSwap,
  onHold,
  onUseHeldAdd,
  onUseHeldDiscard,
}: {
  t: TFn;
  submitting: boolean;
  canHit: boolean;
  canStand: boolean;
  canSwap: boolean;
  canHold: boolean;
  canUseHeldAdd: boolean;
  canUseHeldDiscard: boolean;
  onHit: () => void;
  onStand: () => void;
  onSwap: (idx: 0 | 1) => void;
  onHold: () => void;
  onUseHeldAdd: () => void;
  onUseHeldDiscard: () => void;
}) {
  // Hit / Stand / Swap / Freeze — the four core gameplay buttons per
  // the redesigned layout spec. The consolidated Swap button uses an
  // inline 1st / 2nd toggle to pick which starting card to replace
  // (the underlying server action still requires `swapIndex`).
  const baseBtn =
    "px-4 py-2.5 rounded-xl font-bold text-sm transition disabled:opacity-40 disabled:cursor-not-allowed border-b-2";
  const busy = submitting ? "…" : null;

  // Local state — only lives inside the panel so the parent page.tsx
  // signature stays untouched (no callback shape changes). The
  // natural remount when the ActionPanel unmounts between rounds
  // (during between_rounds / busted / stood reset) means the pick
  // deliberately resets to the first card at the start of every new
  // round — intentional UX, do not lift into parent state.
  const [swapTarget, setSwapTarget] = useState<0 | 1>(0);

  const swapDisabled = !canSwap || submitting;

  return (
    <div className="mt-4 space-y-2.5">
      {/* ── 1st / 2nd toggle pill — selects which starting card the
        consolidated Swap button will replace. Disabled en masse
        when canSwap is false so the player can't pre-arm an inert
        Swap target. */}
      <div className="flex items-center justify-center gap-2">
        <span className="text-[10px] uppercase tracking-[0.25em] text-purple-200/85 font-bold">
          {t("blackjackPvp.swapTargetLabel", "Swap target")}
        </span>
        <div className="inline-flex items-center rounded-full border border-purple-400/40 bg-purple-500/10 p-0.5 shadow-[inset_0_0_8px_rgba(168,85,247,0.18)]">
          {([0, 1] as const).map((idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setSwapTarget(idx)}
              disabled={swapDisabled}
              className={`px-3 py-1 text-xs font-bold rounded-full transition ${
                swapTarget === idx
                  ? "bg-purple-400 text-black shadow-[0_0_10px_rgba(168,85,247,0.55)]"
                  : "text-purple-200 hover:bg-purple-400/25"
              } disabled:hover:bg-transparent`}
              aria-pressed={swapTarget === idx}
            >
              {idx === 0
                ? t("blackjackPvp.swapCard1st", "1st")
                : t("blackjackPvp.swapCard2nd", "2nd")}
            </button>
          ))}
        </div>
      </div>

      {/* ── Hit / Stand / Swap / Freeze — 4-button row */ }
      <div className="flex justify-center gap-2 flex-wrap">
        <button
          onClick={onHit}
          disabled={!canHit || submitting}
          className={`${baseBtn} border-[#FFD700]/40 bg-[#FFD700]/15 text-[#FFD700] hover:bg-[#FFD700]/25 shadow-[0_0_10px_rgba(255,215,0,0.35)]`}
        >
          {busy ?? t("blackjackPvp.hit", "Hit")}
        </button>
        <button
          onClick={onStand}
          disabled={!canStand || submitting}
          className={`${baseBtn} border-[#00e5ff]/45 bg-[#00e5ff]/15 text-[#9ff4ff] hover:bg-[#00e5ff]/25 shadow-[0_0_10px_rgba(0,229,255,0.35)]`}
        >
          {busy ?? t("blackjackPvp.stand", "Stand")}
        </button>
        <button
          onClick={() => onSwap(swapTarget)}
          disabled={swapDisabled}
          title={t(
            "blackjackPvp.swapHint",
            "Replace your {n} starting card",
          ).replace("{n}", swapTarget === 0 ? "1st" : "2nd")}
          className={`${baseBtn} border-purple-400/45 bg-purple-500/15 text-purple-100 hover:bg-purple-500/25 shadow-[0_0_10px_rgba(168,85,247,0.35)]`}
        >
          {busy ?? t("blackjackPvp.swap", "Swap")}
        </button>
        <button
          onClick={onHold}
          disabled={!canHold || submitting}
          title={t(
            "blackjackPvp.freezeHint",
            "Stash your most recently drawn card aside for later",
          )}
          className={`${baseBtn} border-sky-300/45 bg-sky-300/10 text-sky-100 hover:bg-sky-300/25 shadow-[0_0_10px_rgba(125,211,252,0.30)]`}
        >
          {busy ?? t("blackjackPvp.freeze", "Freeze")}
        </button>
      </div>

      {/* ── Resolve frozen (held) card sub-row. Sub-button row only
        surfaces when the player has a card on hold that hasn't been
        resolved yet. Stylistic complement to the Swap pill so the
        decision grid feels deliberate. */}
      {(canUseHeldAdd || canUseHeldDiscard) && (
        <div className="flex justify-center gap-2 flex-wrap pt-1">
          <button
            onClick={onUseHeldAdd}
            disabled={!canUseHeldAdd || submitting}
            className={`${baseBtn} border-emerald-400/45 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25 shadow-[0_0_10px_rgba(16,185,129,0.30)]`}
          >
            {busy ?? t("blackjackPvp.useHeldAdd", "Use frozen card")}
          </button>
          <button
            onClick={onUseHeldDiscard}
            disabled={!canUseHeldDiscard || submitting}
            className={`${baseBtn} border-red-400/45 bg-red-500/15 text-red-200 hover:bg-red-500/25 shadow-[0_0_10px_rgba(239,68,68,0.30)]`}
          >
            {busy ?? t("blackjackPvp.useHeldDiscard", "Discard frozen")}
          </button>
        </div>
      )}
    </div>
  );
}

function WaitingBanner({
  t,
  onCancel,
  isOwner,
}: {
  t: TFn;
  onCancel: () => Promise<void>;
  isOwner: boolean;
}) {
  return (
    <div className="mt-4 text-center text-sm text-white/70">
      <p className="mb-1">
        {t("blackjackPvp.status.waiting", "En attente d'un adversaire…")}
      </p>
      {isOwner && (
        <button
          onClick={onCancel}
          className="mt-2 px-4 py-1.5 rounded-lg border border-red-400/30 bg-red-500/15 text-red-300 text-xs font-bold hover:bg-red-500/25 transition"
        >
          {t("blackjackPvp.lobby.cancel", "Annuler la lobby")}
        </button>
      )}
    </div>
  );
}

function GameTableCenter({
  t,
  viewerIsPlayer1,
  status,
  roundNumber,
  totalRounds,
  myRounds,
  oppRounds,
  mySeatLabel,
  oppSeatLabel,
}: {
  t: TFn;
  viewerIsPlayer1: boolean;
  status: string;
  // Prompt 9 schema refactor: caller passes `roundNumber` (the spec
  // name) so the destructure + type field use roundNumber.
  roundNumber: number;
  totalRounds: number;
  myRounds: number;
  oppRounds: number;
  mySeatLabel: string;
  oppSeatLabel: string;
}) {
  // GameTableCenter stays visible across `ready` (warm-up banner) and
  // `between_rounds` (transitional countdown) — both surface the round
  // indicator so the table layout doesn't flicker in/out. We hide
  // only the pre-pairing `waiting` state, where there's no match row
  // yet and showing "Round 1/3" would be misleading.
  if (status === "waiting") {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="my-5 rounded-2xl border border-[#FFD700]/30 bg-gradient-to-b from-[#00111f]/85 via-[#000c1a]/85 to-[#000814]/85 px-4 sm:px-6 py-4 shadow-[0_0_24px_rgba(255,215,0,0.15)]"
    >
      <div className="flex items-center justify-between gap-3 sm:gap-6">
        {/* LEFT — viewer's seat round score */}
        <div className="flex flex-col items-start min-w-0">
          <span className="text-[10px] sm:text-xs uppercase tracking-[0.25em] text-[#FFD700]/75 font-bold">
            {t("blackjackPvp.scoreboard.player", "Player")}
          </span>
          <div className="flex items-baseline gap-1.5 mt-1">
            <span
              className={`text-3xl sm:text-4xl font-black leading-none ${
                viewerIsPlayer1 ? "text-white" : "text-white"
              }`}
            >
              {myRounds}
            </span>
            <span className="text-[11px] uppercase tracking-widest text-[#FFD700]/70 font-bold">
              {t("blackjackPvp.scoreboard.roundsUnit", "rd")}
            </span>
          </div>
          <span className="text-[10px] uppercase tracking-widest text-white/50 mt-1 truncate max-w-[110px]">
            {mySeatLabel}
          </span>
        </div>

        {/* CENTER — current round chip (prominent Round N/3) */}
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-[10px] sm:text-xs uppercase tracking-[0.25em] text-[#FFD700]/70 font-bold">
            {t("blackjackPvp.scoreboard.roundLabel", "Round")}
          </span>
          <div
            className="rounded-full border-2 border-[#FFD700]/65 bg-gradient-to-b from-[#FFD700]/30 to-[#FFD700]/8 px-4 sm:px-5 py-1.5 sm:py-2 shadow-[0_0_18px_rgba(255,215,0,0.45)] flex items-center gap-0.5"
          aria-label={`Round ${roundNumber} of ${totalRounds}`}
        >
          <span className="text-2xl sm:text-3xl font-black text-[#fffec7] leading-none">
            {roundNumber}
          </span>
            <span className="text-base sm:text-lg text-[#FFD700]/65 font-black leading-none">
              /{totalRounds}
            </span>
          </div>
        </div>

        {/* RIGHT — opponent's seat round score */}
        <div className="flex flex-col items-end min-w-0">
          <span className="text-[10px] sm:text-xs uppercase tracking-[0.25em] text-[#FFD700]/75 font-bold">
            {t("blackjackPvp.scoreboard.opponent", "Opponent")}
          </span>
          <div className="flex items-baseline gap-1.5 mt-1">
            <span className="text-3xl sm:text-4xl font-black text-white leading-none">
              {oppRounds}
            </span>
            <span className="text-[11px] uppercase tracking-widest text-[#FFD700]/70 font-bold">
              {t("blackjackPvp.scoreboard.roundsUnit", "rd")}
            </span>
          </div>
          <span className="text-[10px] uppercase tracking-widest text-white/50 mt-1 truncate max-w-[110px]">
            {oppSeatLabel}
          </span>
        </div>
      </div>
    </motion.div>
  );
}

function RoundResultModal({
  t,
  round,
  viewerIsPlayer1,
  onDismiss,
}: {
  t: TFn;
  round: RoundRow;
  viewerIsPlayer1: boolean;
  onDismiss: () => void;
}) {
  const won =
    (round.roundWinner === "player1" && viewerIsPlayer1) ||
    (round.roundWinner === "player2" && !viewerIsPlayer1);
  const lost =
    (round.roundWinner === "player1" && !viewerIsPlayer1) ||
    (round.roundWinner === "player2" && viewerIsPlayer1);
  const isDraw = round.roundWinner === "draw";

  // Round-end reveal — both hands fully revealed by the server's
  // rounds history payload. The orchestration of WHEN each element
  // becomes visible is a client-only concern handled by the phase
  // state machine below.
  const p1Hand = round.player1Hand;
  const p2Hand = round.player2Hand;
  const p1Score = round.player1Score;
  const p2Score = round.player2Score;
  const p1Busted = round.player1State === "busted";
  const p2Busted = round.player2State === "busted";

  // ── 6-phase orchestrated reveal ────────────────────────────────
  //   phase 0 — TEASER  (0–700ms):   "Revealing hands…" pulse; both
  //                                seats face-down with pulse.
  //   phase 1 — PLAYER  (700–1500ms): viewer's hand flips face-up,
  //                                 opponent remains face-down.
  //   phase 2 — OPPONENT(1500–2300ms): opponent's hand flips face-up.
  //   phase 3 — SCORES  (2300–3100ms): both totals appear below the
  //                                 hands + priority rule banner.
  //   phase 4 — HIGHLIGHT(3100–3900ms): winning seat gets gold
  //                                 border + crown badge; losing
  //                                 seat dims. Modal container
  //                                 border shifts to win/loss tint.
  //   phase 5 — AWARD   (3900ms+):   full outcome header (emoji +
  //                                 "Round N awarded to YOU/OPPONENT/
  //                                 tie") + Continue button +
  //                                 5-second auto-dismiss.
  //
  // Both click targets (backdrop + footer button) dismiss
  // immediately at any phase. The footer button has a different
  // label across phases so the player can read the intent of their
  // action without having to deconstruct the animation. The 5-second
  // auto-dismiss countdown is the safety net for impatient players
  // who don't tap anything.
  type Phase = 0 | 1 | 2 | 3 | 4 | 5;
  const PHASE_TIMES_MS: Array<[Phase, number]> = [
    [1, 700],
    [2, 1500],
    [3, 2300],
    [4, 3100],
    [5, 3900],
  ];
  const AUTO_DISMISS_SECONDS = 5;
  const [phase, setPhase] = useState<Phase>(0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    const timers = PHASE_TIMES_MS.map(([target, ms]) =>
      setTimeout(() => setPhase(target), ms),
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  // Auto-dismiss countdown only kicks in once the AWARD header is
  // visible — i.e. phase 5. Before that, the modal stays until the
  // player presses Continue / Skip / clicks the backdrop.
  useEffect(() => {
    if (phase !== 5) return;
    setSecondsLeft(AUTO_DISMISS_SECONDS);
  }, [phase]);

  useEffect(() => {
    if (secondsLeft == null) return;
    if (secondsLeft <= 0) {
      onDismiss();
      return;
    }
    const id = setTimeout(
      () => setSecondsLeft((s) => (s == null ? null : s - 1)),
      1000,
    );
    return () => clearTimeout(id);
  }, [secondsLeft, onDismiss]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 px-4 backdrop-blur-sm"
      onClick={onDismiss}
    >
      <motion.div
        initial={{ scale: 0.85, y: 30 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.85, y: 30 }}
        transition={{ type: "spring", stiffness: 300, damping: 18 }}
        onClick={(e) => e.stopPropagation()}
        className={`relative w-full max-w-lg rounded-3xl border-4 p-5 sm:p-7 text-center shadow-2xl transition-colors duration-700 ${
          phase >= 4
            ? won
              ? "border-amber-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_50px_rgba(251,191,36,0.35)]"
              : lost
              ? "border-red-500 bg-gradient-to-b from-[#3a1a1a] to-[#2b0d0d] shadow-[0_0_40px_rgba(239,68,68,0.25)]"
              : "border-yellow-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_40px_rgba(250,204,21,0.25)]"
            : "border-[#FFD700]/35 bg-gradient-to-b from-[#0c1633]/95 to-[#040a1a]/95 shadow-[0_0_30px_rgba(255,215,0,0.12)]"
        }`}
      >
        {/* ── Header — phase < 5 shows the "Revealing hands…"
               teaser with a sparkle pulse. Phase 5 swaps in the
               full outcome banner (trophy/skull/handshake + bold
               "Round N awarded to YOU / OPPONENT / tied" + tight
               WIN/LOSS/DRAW headline) for the auto-dismiss hold. */}
        <div className="min-h-[132px] flex flex-col items-center justify-center">
          <AnimatePresence mode="wait" initial={false}>
            {phase < 5 ? (
              <motion.div
                key="teaser-header"
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.35 }}
                className="flex flex-col items-center"
              >
                <div className="text-3xl mb-1">✨</div>
                <h2 className="text-xl sm:text-2xl font-black uppercase text-white/90">
                  {t(
                    "blackjackPvp.roundResultHeader",
                    "Manche {n} — Révelation des mains",
                  ).replace("{n}", String(round.roundNumber))}
                </h2>
                <p className="mt-2 text-sm font-black uppercase tracking-[0.25em] text-[#FFD700] animate-pulse">
                  {t("blackjackPvp.revealTeaser", "Révélation des mains…")}
                </p>
                <p className="mt-1 text-[10px] uppercase tracking-widest text-white/55">
                  {t(
                    "blackjackPvp.revealTeaserHint",
                    "Les deux mains se découvrent simultanément",
                  )}
                </p>
              </motion.div>
            ) : (
              <motion.div
                key="award-header"
                initial={{ opacity: 0, y: -16, scale: 0.92 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 260, damping: 18 }}
                className="flex flex-col items-center"
              >
                <motion.div
                  initial={{ scale: 0, rotate: -30 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ delay: 0.15, type: "spring", stiffness: 220 }}
                  className="mb-2 text-6xl"
                >
                  {won ? "🏆" : isDraw ? "🤝" : "💀"}
                </motion.div>
                <h2
                  className={`text-2xl sm:text-3xl font-black uppercase ${
                    won
                      ? "text-amber-300"
                      : isDraw
                      ? "text-yellow-300"
                      : "text-red-400"
                  }`}
                >
                  {won
                    ? t("blackjackPvp.roundWon", "Manche gagnée !")
                    : isDraw
                    ? t("blackjackPvp.roundDraw", "Égalité")
                    : t("blackjackPvp.roundLost", "Manche perdue")}
                </h2>
                <p className="mt-1 text-sm text-white/85">
                  {won
                    ? t(
                        "blackjackPvp.awardRoundYou",
                        "Manche {n} remportée par Vous",
                      ).replace("{n}", String(round.roundNumber))
                    : isDraw
                    ? t(
                        "blackjackPvp.awardRoundDraw",
                        "Manche {n} — égalité",
                      ).replace("{n}", String(round.roundNumber))
                    : t(
                        "blackjackPvp.awardRoundOpp",
                        "Manche {n} remportée par l'Adversaire",
                      ).replace("{n}", String(round.roundNumber))}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Dynamic seats — the per-phase rollout of cards →
               score → highlight is encoded by the three booleans
               on each `<RevealedSeat>`. The seat on the LEFT is
               always the VIEWER; the right is the opponent. */}
        <div className="mt-5 grid grid-cols-2 gap-3 text-left">
          <RevealedSeat
            label={
              viewerIsPlayer1
                ? t("blackjackPvp.seat.player1", "Joueur 1")
                : t("blackjackPvp.seat.player2", "Joueur 2")
            }
            hand={viewerIsPlayer1 ? p1Hand : p2Hand}
            score={viewerIsPlayer1 ? p1Score : p2Score}
            busted={viewerIsPlayer1 ? p1Busted : p2Busted}
            didWin={won}
            highlight="self"
            showCards={phase >= 1}
            showScore={phase >= 3}
            showHighlight={phase >= 4}
            t={t}
          />
          <RevealedSeat
            label={t("blackjackPvp.seat.opponent", "Adversaire")}
            hand={viewerIsPlayer1 ? p2Hand : p1Hand}
            score={viewerIsPlayer1 ? p2Score : p1Score}
            busted={viewerIsPlayer1 ? p2Busted : p1Busted}
            didWin={lost}
            highlight="opp"
            showCards={phase >= 2}
            showScore={phase >= 3}
            showHighlight={phase >= 4}
            t={t}
          />
        </div>

        {/* ── Phase 3+: priority rule banner slides in to remind the
               player WHY this round outcome was decided. */}
        <AnimatePresence>
          {phase >= 3 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.3 }}
              className="mt-4 rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-left"
            >
              <p className="text-[10px] sm:text-xs uppercase tracking-widest text-[#FFD700]/80 font-bold">
                {t("blackjackPvp.priority.title", "Règle de résolution")}
              </p>
              <ol className="mt-1 text-xs text-white/85 space-y-0.5 list-decimal list-inside">
                <li>
                  {t(
                    "blackjackPvp.priority.rule1",
                    "Score le plus élevé ≤ 21 gagne",
                  )}
                </li>
                <li>
                  {t(
                    "blackjackPvp.priority.rule2",
                    "Sauté (>21) = défaite automatique",
                  )}
                </li>
                <li>
                  {t(
                    "blackjackPvp.priority.rule3",
                    "Score égal = manche nulle",
                  )}
                </li>
              </ol>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Footer button — before phase 5 the button reads
               "Skip reveal" and clicking it jumps to phase 5. After
               phase 5 it reads "Continue" and clicks dismiss.
               Auto-dismiss countdown is rendered as a transparent
               suffix only during phase 5 so the player always knows
               how long the modal will hold. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className={`mt-5 inline-flex items-center justify-center gap-2 rounded-xl border-b-4 px-6 py-2.5 text-base font-black transition active:translate-y-[2px] ${
            phase >= 5
              ? won
                ? "border-amber-700 bg-amber-400 text-black"
                : "border-cyan-700 bg-cyan-400 text-black"
              : "border-white/15 bg-white/10 text-white/80 hover:bg-white/15"
          }`}
        >
          {phase >= 5
            ? t("blackjackPvp.continue", "Continuer")
            : t("blackjackPvp.skipReveal", "Skip reveal")}
          {phase >= 5 && secondsLeft != null && (
            <span className="text-xs opacity-80">({secondsLeft}s)</span>
          )}
        </button>
      </motion.div>
    </motion.div>
  );
}

// One seat of the side-by-side round-result display. The 3 booleans
// (`showCards`, `showScore`, `showHighlight`) are driven by the
// parent's phase state machine so this component stays purely
// declarative — it doesn't know WHETHER it's the player's hand vs
// the opponent's, just whether each visual layer should be visible.
//
//   showCards    — when false the seat renders card backs; flipping
//                  face-up uses the rotateY + stagger delays below.
//   showScore    — the total line below the cards; reveals in
//                  spring-bounce fashion so the comparison lands as a
//                  distinct visual beat after both hands are open.
//   showHighlight— the gold border + glow + crown badge on the
//                  winning seat. The losing seat dims slightly so
//                  the contrast reads at a glance.
function RevealedSeat({
  label,
  hand,
  score,
  busted,
  didWin,
  highlight,
  showCards,
  showScore,
  showHighlight,
  t,
}: {
  label: string;
  hand: Card[];
  score: number;
  busted: boolean;
  didWin: boolean;
  highlight: "self" | "opp";
  showCards: boolean;
  showScore: boolean;
  showHighlight: boolean;
  t: TFn;
}) {
  // Border / glow palette. While !showHighlight we keep the seat on
  // the neutral palette so the gold border sweep at phase 4 reads as
  // a deliberate decision event, not a fixed visual decoration.
  const seatBorder = busted
    ? "border-red-400/70"
    : didWin
    ? "border-amber-300/80"
    : "border-white/20";
  const seatBg = busted
    ? "bg-red-950/35"
    : didWin
    ? "bg-amber-950/30"
    : "bg-black/30";
  const seatGlow = didWin
    ? "shadow-[0_0_22px_rgba(251,191,36,0.55)]"
    : "shadow-none";
  return (
    <motion.div
      className={`relative rounded-2xl border-2 p-2 flex flex-col items-center gap-2 transition-colors duration-500 ${
        showHighlight
          ? `${seatBorder} ${seatBg} ${didWin ? seatGlow : "shadow-none"}`
          : "border-white/10 bg-black/20 shadow-none"
      } ${!showHighlight && didWin ? "opacity-90" : ""} ${
        showHighlight && !didWin && !busted ? "opacity-65" : ""
      }`}
    >
      {/* Crown badge — only on the winning seat during phase 5
         (HIGHLIGHT). Spring-bounce entrance so it reads as a
         decision event rather than a static decoration. */}
      <AnimatePresence>
        {showHighlight && didWin && (
          <motion.div
            key="crown-badge"
            initial={{ scale: 0, rotate: -30, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 14 }}
            className="absolute -top-3 -right-2 text-2xl drop-shadow-md pointer-events-none"
            aria-hidden
          >
            👑
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={`flex items-center gap-1 text-[10px] sm:text-xs font-bold ${
          showHighlight && didWin ? "text-amber-200" : "text-white/85"
        }`}
      >
        {highlight === "self" ? `★ ${label}` : label}
      </div>

      <div className="flex justify-center gap-1.5 flex-wrap min-h-[96px]">
        {hand.length === 0 ? (
          <BlackjackCardBack />
        ) : !showCards ? (
          hand.map((_, i) => (
            <motion.div
              key={`back-${i}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
            >
              <BlackjackCardBack />
            </motion.div>
          ))
        ) : (
          hand.map((c, i) => (
            <motion.div
              key={i}
              initial={{ rotateY: 90, opacity: 0, y: -10 }}
              animate={{ rotateY: 0, opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.15 + i * 0.08 }}
            >
              <CardFace card={c} small />
            </motion.div>
          ))
        )}
      </div>

      {/* Score line — appears at phase 3 with a brief pulse so the
         numerical comparison lands AFTER both hands are visible.
         Score line is always reserved height so swapping in/out
         doesn't reflow the parent grid. */}
      <div className="h-6 flex items-center justify-center">
        <AnimatePresence>
          {showScore && (
            <motion.div
              key="score"
              initial={{ opacity: 0, scale: 0.7, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{
                type: "spring",
                stiffness: 320,
                damping: 16,
                delay: 0.05,
              }}
              className={`text-sm font-black ${
                busted
                  ? "text-red-300"
                  : didWin
                  ? "text-amber-300"
                  : "text-white/80"
              }`}
            >
              {busted
                ? t("blackjackPvp.bustedScore", "Sauté ({score})").replace(
                    "{score}",
                    String(score),
                  )
                : `${score} ${t("blackjackPvp.ptsUnit", "pts")}`}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function MatchEndModal({
  t,
  stake,
  prizePaid,
  houseFee,
  winner: winnerId,
  userId,
  result,
  onBackToLobby,
}: {
  t: TFn;
  stake: number;
  prizePaid: number;
  houseFee: number;
  // Prompt 9 schema refactor: caller passes `winner` so the prop
  // rename matches.
  winner: string | null;
  userId: string | null;
  result: string | null;
  onBackToLobby: () => void;
}) {
  const won = Boolean(winnerId) && userId === winnerId;
  const draw = result === "draw";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.85, y: 30 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.85, y: 30 }}
        transition={{ type: "spring", stiffness: 300, damping: 18 }}
        className={`relative w-full max-w-md rounded-3xl border-4 p-6 text-center shadow-2xl ${
          won
            ? "border-amber-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_60px_rgba(251,191,36,0.45)]"
            : draw
            ? "border-yellow-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_40px_rgba(250,204,21,0.25)]"
            : "border-red-500 bg-gradient-to-b from-[#3a1a1a] to-[#2b0d0d] shadow-[0_0_40px_rgba(239,68,68,0.25)]"
        }`}
      >
        <motion.div
          initial={{ scale: 0, rotate: -30 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ delay: 0.2 }}
          className="mb-2 text-7xl"
        >
          {won ? "🏆" : draw ? "🤝" : "💀"}
        </motion.div>
        <h2
          className={`mt-2 text-3xl font-black uppercase ${
            won ? "text-amber-300" : draw ? "text-yellow-300" : "text-red-400"
          }`}
        >
          {won
            ? t("blackjackPvp.matchWin", "Victoire !")
            : draw
            ? t("blackjackPvp.matchDraw", "Égalité")
            : t("blackjackPvp.matchLose", "Défaite")}
        </h2>
        <p className="mt-2 text-white/80 text-sm leading-relaxed">
          {won && (
            <>
              {t("blackjackPvp.matchWinDetail", "Vous remportez")}{" "}
              <span className="text-amber-300 font-bold">
                {prizePaid.toLocaleString()}
              </span>{" "}
              {t(
                "blackjackPvp.tokensUnit",
                "tokens (pot {pot} − commission {fee}).",
              )
                .replace("{pot}", String(stake * 2))
                .replace("{fee}", houseFee.toLocaleString())}
            </>
          )}
          {draw && (
            <>
              {t(
                "blackjackPvp.matchDrawDetail",
                "Manche décisive. Votre mise de {amount} tokens vous est remboursée.",
              ).replace("{amount}", stake.toLocaleString())}
            </>
          )}
          {!won && !draw && (
            <>
              {t(
                "blackjackPvp.matchLoseDetail",
                "Vous perdez votre mise de {amount} tokens. Bonne chance la prochaine fois !",
              ).replace("{amount}", stake.toLocaleString())}
            </>
          )}
        </p>
        <button
          onClick={onBackToLobby}
          className={`mt-6 rounded-xl border-b-4 px-7 py-2.5 text-base font-black transition active:translate-y-[2px] ${
            won
              ? "border-amber-700 bg-amber-400 text-black"
              : "border-cyan-700 bg-cyan-400 text-black"
          }`}
        >
          {t("blackjackPvp.lobby.back", "Retour au lobby")}
        </button>
      </motion.div>
    </motion.div>
  );
}

function CancelledModal({
  t,
  onBackToLobby,
}: {
  t: TFn;
  onBackToLobby: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.85, y: 30 }}
        animate={{ scale: 1, y: 0 }}
        className="relative w-full max-w-md rounded-3xl border-4 border-white/30 bg-gradient-to-b from-[#1a1a3a] to-[#0d0d2b] p-6 text-center shadow-2xl"
      >
        <div className="mb-2 text-7xl">❌</div>
        <h2 className="mt-2 text-3xl font-black uppercase text-white">
          {t("blackjackPvp.status.cancelled", "Partie annulée")}
        </h2>
        <p className="mt-2 text-white/80 text-sm">
          {t(
            "blackjackPvp.cancelled.detail",
            "La partie a été annulée. Si un adversaire n'avait pas encore rejoint, votre mise vous a été remboursée.",
          )}
        </p>
        <button
          onClick={onBackToLobby}
          className="mt-6 rounded-xl border-b-4 border-cyan-700 bg-cyan-400 text-black px-7 py-2.5 text-base font-black transition active:translate-y-[2px]"
        >
          {t("blackjackPvp.lobby.back", "Retour au lobby")}
        </button>
      </motion.div>
    </motion.div>
  );
}

// ── Between-rounds transition screen ─────────────────────────────────
// Best-of-3 spec: after a round resolves, the server sits in
// MATCH_STATUS.BETWEEN_ROUNDS for BETWEEN_ROUNDS_MS (default 3 s).
// This component is the matching client UI for that state — it shows
// the running match score, the upcoming round number, and a
// "Continue now" button that POSTs to /api/blackjack-pvp/match/[id]/
// continue so the player can skip the wait.
//
// Components: visual transition <BetweenRoundsScreen /> is shown in
// place of the active hand sections whenever `match.status ===
// "between_rounds"` so the player cannot issue new actions during
// the transition.
function BetweenRoundsScreen({
  t,
  matchId,
  nextRound,
  totalRounds,
  roundsWonPlayer1: scorePlayer1,
  roundsWonPlayer2: scorePlayer2,
  onAfter,
}: {
  t: TFn;
  matchId: number;
  nextRound: number;
  totalRounds: number;
  roundsWonPlayer1: number;
  roundsWonPlayer2: number;
  onAfter: () => Promise<void>;
}) {
  // Local countdown — counts down once per second, emits an explicit
  // refresh to re-fetch match state so the server's auto-advance
  // delegate (status → next round) surfaces on the page naturally.
  const [secondsLeft, setSecondsLeft] = useState(BETWEEN_ROUNDS_SECONDS);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = setTimeout(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearTimeout(id);
  }, [secondsLeft]);

  // When the countdown hits zero, trigger a polling refresh so the
  // server's auto-advance lands on the page.
  useEffect(() => {
    if (secondsLeft === 0) {
      onAfter();
    }
  }, [secondsLeft, onAfter]);

  const handleContinueNow = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/blackjack-pvp/match/${matchId}/continue`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        // Even on failure, fall through to the polling refresh path
        // — the auto-advance helper will pick up the timeout end.
      }
      await onAfter();
    } catch (e) {
      // Network or server error — the polling loop will eventually
      // pick up the server-side auto-advance.
    } finally {
      setSubmitting(false);
    }
  }, [matchId, onAfter, submitting]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35 }}
      className="text-center mt-3 mb-2 rounded-2xl border-2 border-[#FFD700]/35 bg-gradient-to-b from-[#0b132b]/80 to-[#050a17]/80 px-5 py-7 shadow-[0_0_30px_rgba(255,215,0,0.18)]"
    >
      <div className="text-3xl mb-2">⏭️</div>
      <h3 className="text-xl sm:text-2xl font-black uppercase text-[#FFD700] tracking-widest">
        {t("blackjackPvp.betweenRounds.title", "Manche suivante imminente")}
      </h3>
      <p className="mt-2 text-white/85 text-sm sm:text-base">
        {t(
          "blackjackPvp.betweenRounds.subtitle",
          "Manche {n} / {total} d\u00e9bute dans {seconds}s\u2026",
        )
          .replace("{n}", String(nextRound))
          .replace("{total}", String(totalRounds))
          .replace("{seconds}", String(secondsLeft))}
      </p>
      <div className="mt-3 inline-flex flex-col items-center gap-1 rounded-xl bg-black/40 border border-[#FFD700]/15 px-4 py-2">
        <p className="text-xs uppercase tracking-widest text-[#FFD700]/85 font-bold">
          {t(
            "blackjackPvp.betweenRounds.scoreCaption",
            "Meilleur des 3",
          )}
        </p>
        <p className="text-2xl sm:text-3xl text-white font-black">
          {t(
            "blackjackPvp.betweenRounds.matchScore",
            "Score\u00a0: {p1} – {p2}",
          )
            .replace("{p1}", String(scorePlayer1))
            .replace("{p2}", String(scorePlayer2))}
        </p>
      </div>
      {/* Progress bar — visual countdown feedback (decorative; the
          server-side timer is still authoritative). */}
      <div className="mt-4 h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
        <motion.div
          initial={{ width: "100%" }}
          animate={{
            width: `${Math.max(
              0,
              Math.min(
                100,
                (secondsLeft / Math.max(1, BETWEEN_ROUNDS_SECONDS)) * 100,
              ),
            )}%`,
          }}
          transition={{ duration: 1, ease: "linear" }}
          className="h-full bg-[#FFD700]"
        />
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          handleContinueNow();
        }}
        disabled={submitting}
        className="mt-5 inline-flex items-center gap-2 rounded-xl border-b-4 border-cyan-700 bg-cyan-400 text-black px-6 py-2.5 text-base font-black transition active:translate-y-[2px] disabled:opacity-50"
      >
        {submitting
          ? "…"
          : t(
              "blackjackPvp.betweenRounds.continueNow",
              "Continuer maintenant",
            )}
      </button>
    </motion.div>
  );
}

// ── Helpers (mirror constants so the file is self-contained) ─────────
function calcHandValue(cards: Card[]): number {
  let value = 0;
  let aces = 0;
  for (const c of cards || []) {
    if (!c) continue;
    if (c.value === "A") {
      aces++;
      value += 11;
    } else if (["K", "Q", "J"].includes(c.value)) {
      value += 10;
    } else {
      const n = parseInt(c.value, 10);
      value += Number.isFinite(n) ? n : 0;
    }
  }
  while (value > 21 && aces > 0) {
    value -= 10;
    aces--;
  }
  return value;
}
