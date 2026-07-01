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
  currentRound: number;
  scorePlayer1: number;
  scorePlayer2: number;
  player1Hand: Card[];
  player2Hand: Card[];
  player1State: string;
  player2State: string;
  viewerIsPlayer1: boolean;
  roundDeadline: string | null;
  winnerId: string | null;
  result: string | null;
  prizePaid: number;
  houseFee: number;
  roundTimer: number;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  player1SwapsUsed: number;
  player2SwapsUsed: number;
  player1HoldsUsed: number;
  player2HoldsUsed: number;
  player1HeldCard: Card | null;
  player2HeldCard: Card | null;
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
  const myActions: SeatActions = match
    ? viewerIsPlayer1
      ? {
          swapsUsed: match.player1SwapsUsed,
          holdsUsed: match.player1HoldsUsed,
          heldCard: match.player1HeldCard,
          heldResolved: match.player1HeldResolved,
        }
      : {
          swapsUsed: match.player2SwapsUsed,
          holdsUsed: match.player2HoldsUsed,
          heldCard: match.player2HeldCard,
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
          round: next.currentRound,
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
      match.winnerId &&
      user?.id === match.winnerId &&
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
      match.winnerId &&
      user?.id !== match.winnerId &&
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

  const canSwap =
    isMyTurn &&
    myState === "playing" &&
    myHand.length >= 2 &&
    (myActions.swapsUsed ?? 0) < SWAP_LIMIT_PER_ROUND;
  const canHold =
    isMyTurn &&
    myState === "playing" &&
    myHand.length >= 2 &&
    (myActions.holdsUsed ?? 0) < HOLD_LIMIT_PER_ROUND &&
    !myActions.heldCard;
  const canUseHeldAdd =
    isMyTurn &&
    (myState === "playing" || myState === "stood") &&
    Boolean(myActions.heldCard) &&
    !myActions.heldResolved;
  const canUseHeldDiscard =
    isMyTurn &&
    (myState === "playing" || myState === "stood") &&
    Boolean(myActions.heldCard) &&
    !myActions.heldResolved;
  const canHit = isMyTurn && myState === "playing" && myScore < 21;
  const canStand = isMyTurn && myState === "playing";

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
      case "round_1":
        return t("blackjackPvp.status.roundN", "Manche {n} / 3").replace(
          "{n}",
          "1",
        );
      case "round_2":
        return t("blackjackPvp.status.roundN", "Manche {n} / 3").replace(
          "{n}",
          "2",
        );
      case "round_3":
        return t("blackjackPvp.status.roundN", "Manche {n} / 3").replace(
          "{n}",
          "3",
        );
      case "finished":
        if (match.result === "draw")
          return t(
            "blackjackPvp.status.finishedDraw",
            "Égalité — mise remboursée",
          );
        if (match.winnerId === user?.id)
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
          {/* Status banner */}
          <div className="text-center mb-3">
            <motion.h2
              key={match?.status ?? "loading"}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-[#FFD700] text-base sm:text-lg font-bold"
            >
              {statusLabel}
            </motion.h2>
            {match?.status !== "waiting" &&
              match?.status !== "cancelled" && (
                <p className="text-[#FFD700]/70 text-xs mt-0.5">
                  {t(
                    "blackjackPvp.scoreboardLabel",
                    "Score : {p1} – {p2}",
                  )
                    .replace("{p1}", String(match?.scorePlayer1 ?? 0))
                    .replace("{p2}", String(match?.scorePlayer2 ?? 0))}
                </p>
              )}
          </div>

          {/* Opponent's section — always face-down + localized
             "Opponent Playing…" placeholder text. Never reveals
             anything else. */}
          <OpponentHand
            t={t}
            label={oppSeatLabel}
            hand={oppHand}
            isMatchFinished={match?.status === "finished"}
          />

          <div className="my-4 h-px bg-[#FFD700]/20" />

          {/* My section — face-up cards. */}
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
                match.winnerId === user?.id
                  ? "text-amber-300"
                  : match.result === "draw"
                  ? "text-yellow-300"
                  : "text-red-300"
              }`}
            >
              {match.winnerId === user?.id
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
              nextRound={Number(match.currentRound) + 1}
              totalRounds={3}
              scorePlayer1={Number(match.scorePlayer1) || 0}
              scorePlayer2={Number(match.scorePlayer2) || 0}
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
          {/* After standing, the player can still resolve their held
              card (Add or Discard). No Hit/Stand allowed here. */}
          {isMyTurn && myState === "stood" && (canUseHeldAdd || canUseHeldDiscard) && (
            <ActionPanel
              t={t}
              submitting={submitting}
              canHit={false}
              canStand={false}
              canSwap={false}
              canHold={false}
              canUseHeldAdd={canUseHeldAdd}
              canUseHeldDiscard={canUseHeldDiscard}
              onHit={() => {}}
              onStand={() => {}}
              onSwap={() => {}}
              onHold={() => {}}
              onUseHeldAdd={() =>
                sendAction("use_held", { subaction: "add" })
              }
              onUseHeldDiscard={() =>
                sendAction("use_held", { subaction: "discard" })
              }
            />
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
            winnerId={match.winnerId}
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
  const baseBtn =
    "px-4 py-2 rounded-lg font-semibold text-sm transition disabled:opacity-40 disabled:cursor-not-allowed";
  const busy = submitting ? "…" : null;
  return (
    <div className="mt-4 space-y-2">
      <div className="flex justify-center gap-2 flex-wrap">
        <button
          onClick={onHit}
          disabled={!canHit || submitting}
          className={`${baseBtn} border border-[#FFD700]/30 bg-[#FFD700]/15 text-[#FFD700] hover:bg-[#FFD700]/25`}
        >
          {busy ?? t("blackjackPvp.hit", "Carte")}
        </button>
        <button
          onClick={onStand}
          disabled={!canStand || submitting}
          className={`${baseBtn} border border-[#00e5ff]/30 bg-[#00e5ff]/15 text-[#00e5ff] hover:bg-[#00e5ff]/25`}
        >
          {busy ?? t("blackjackPvp.stand", "Rester")}
        </button>
        <button
          onClick={() => onSwap(0)}
          disabled={!canSwap || submitting}
          title={t(
            "blackjackPvp.swap1stHint",
            "Replace your 1st starting card",
          )}
          className={`${baseBtn} border border-purple-400/30 bg-purple-400/10 text-purple-200 hover:bg-purple-400/20`}
        >
          {busy ?? t("blackjackPvp.swap1st", "Permuter 1ère carte")}
        </button>
        <button
          onClick={() => onSwap(1)}
          disabled={!canSwap || submitting}
          title={t(
            "blackjackPvp.swap2ndHint",
            "Replace your 2nd starting card",
          )}
          className={`${baseBtn} border border-purple-400/30 bg-purple-400/10 text-purple-200 hover:bg-purple-400/20`}
        >
          {busy ?? t("blackjackPvp.swap2nd", "Permuter 2ème carte")}
        </button>
        <button
          onClick={onHold}
          disabled={!canHold || submitting}
          title={t(
            "blackjackPvp.holdHint",
            "Set aside your most recently drawn card",
          )}
          className={`${baseBtn} border border-amber-400/30 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20`}
        >
          {busy ?? t("blackjackPvp.hold", "Mettre de côté")}
        </button>
      </div>
      {(canUseHeldAdd || canUseHeldDiscard) && (
        <div className="flex justify-center gap-2 flex-wrap">
          <button
            onClick={onUseHeldAdd}
            disabled={!canUseHeldAdd || submitting}
            className={`${baseBtn} border border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20`}
          >
            {busy ?? t("blackjackPvp.useHeldAdd", "Ajouter la réserve")}
          </button>
          <button
            onClick={onUseHeldDiscard}
            disabled={!canUseHeldDiscard || submitting}
            className={`${baseBtn} border border-red-400/30 bg-red-400/10 text-red-200 hover:bg-red-400/20`}
          >
            {busy ??
              t("blackjackPvp.useHeldDiscard", "Jeter la réserve")}
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

  // Round-end reveal — both hands disclosed simultaneously so each
  // player can see the comparison that produced the round-winner.
  const p1Hand = round.player1Hand;
  const p2Hand = round.player2Hand;
  const p1Score = round.player1Score;
  const p2Score = round.player2Score;
  const p1Busted = round.player1State === "busted";
  const p2Busted = round.player2State === "busted";

  // Per-seat winner highlighting for the side-by-side reveal. The
  // modal ALWAYS lays out the viewer first (top) for narrative flow,
  // even though the actual seat keys are player1/player2.
  const topWon =
    round.roundWinner === "player1" || round.roundWinner === "player2"
      ? (round.roundWinner === "player1" && viewerIsPlayer1) ||
        (round.roundWinner === "player2" && !viewerIsPlayer1)
      : false;
  const bottomWon =
    round.roundWinner === "player1" || round.roundWinner === "player2"
      ? (round.roundWinner === "player1" && !viewerIsPlayer1) ||
        (round.roundWinner === "player2" && viewerIsPlayer1)
      : false;

  // 5-second auto-dismiss: the matching flow requires the round-
  // result screen to appear BEFORE the next round starts (server has
  // already moved status; this is a soft hold so the player can read
  // the comparison). Player can also dismiss manually.
  const [secondsLeft, setSecondsLeft] = useState(5);
  useEffect(() => {
    if (secondsLeft <= 0) {
      onDismiss();
      return;
    }
    const id = setTimeout(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
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
        className={`relative w-full max-w-lg rounded-3xl border-4 p-5 sm:p-7 text-center shadow-2xl ${
          won
            ? "border-amber-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_50px_rgba(251,191,36,0.35)]"
            : lost
            ? "border-red-500 bg-gradient-to-b from-[#3a1a1a] to-[#2b0d0d] shadow-[0_0_40px_rgba(239,68,68,0.25)]"
            : "border-yellow-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_40px_rgba(250,204,21,0.25)]"
        }`}
      >
        <motion.div
          initial={{ scale: 0, rotate: -30 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ delay: 0.18 }}
          className="mb-2 text-6xl"
        >
          {won ? "🏆" : isDraw ? "🤝" : "💀"}
        </motion.div>
        <h2
          className={`text-2xl sm:text-3xl font-black uppercase ${
            won ? "text-amber-300" : isDraw ? "text-yellow-300" : "text-red-400"
          }`}
        >
          {won
            ? t("blackjackPvp.roundWon", "Manche gagnée !")
            : isDraw
            ? t("blackjackPvp.roundDraw", "Égalité")
            : t("blackjackPvp.roundLost", "Manche perdue")}
        </h2>
        <p className="mt-1 text-sm text-white/80">
          {t(
            "blackjackPvp.roundResultHeader",
            "Manche {n} — Révelation des mains",
          ).replace("{n}", String(round.roundNumber))}
        </p>

        {/* ── Both hands simultaneously revealed ───────────────────── */}
        <div className="mt-4 grid grid-cols-2 gap-3 text-left">
          <RevealedSeat
            label={
              viewerIsPlayer1
                ? t("blackjackPvp.seat.player1", "Joueur 1")
                : t("blackjackPvp.seat.player2", "Joueur 2")
            }
            hand={viewerIsPlayer1 ? p1Hand : p2Hand}
            score={viewerIsPlayer1 ? p1Score : p2Score}
            busted={viewerIsPlayer1 ? p1Busted : p2Busted}
            didWin={topWon}
            highlight="self"
            t={t}
          />
          <RevealedSeat
            label={t("blackjackPvp.seat.opponent", "Adversaire")}
            hand={viewerIsPlayer1 ? p2Hand : p1Hand}
            score={viewerIsPlayer1 ? p2Score : p1Score}
            busted={viewerIsPlayer1 ? p2Busted : p1Busted}
            didWin={bottomWon}
            highlight="opp"
            t={t}
          />
        </div>

        {/* ── Winner-priority text explaining why the round ended
               this way (highest ≤21 wins, bust loses, equal = tie). */}
        <div className="mt-4 rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-left">
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
        </div>

        {/* ── Continue + auto-dismiss countdown ─────────────────────── */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className={`mt-5 rounded-xl border-b-4 px-6 py-2 text-base font-black transition active:translate-y-[2px] ${
            won
              ? "border-amber-700 bg-amber-400 text-black"
              : "border-cyan-700 bg-cyan-400 text-black"
          }`}
        >
          {t("blackjackPvp.continue", "Continuer")}{" "}
          <span className="text-xs opacity-80">({secondsLeft}s)</span>
        </button>
      </motion.div>
    </motion.div>
  );
}

// One seat of the side-by-side round-result display. Both hands are
// fully visible here because rounds only contain resolved-game data.
function RevealedSeat({
  label,
  hand,
  score,
  busted,
  didWin,
  highlight,
  t,
}: {
  label: string;
  hand: Card[];
  score: number;
  busted: boolean;
  didWin: boolean;
  highlight: "self" | "opp";
  t: TFn;
}) {
  const isDraw = !didWin && (score === 0 || score > 0); // draw row uses neutral palette
  const accent =
    didWin
      ? "border-amber-300/80"
      : busted
      ? "border-red-400/80"
      : "border-white/20";
  const scoreText = busted
    ? t("blackjackPvp.bustedScore", "Sauté ({score})").replace(
        "{score}",
        String(score),
      )
    : `${score} ${t("blackjackPvp.ptsUnit", "pts")}`;
  return (
    <div
      className={`rounded-2xl border-2 ${accent} bg-black/30 p-2 flex flex-col items-center gap-2`}
    >
      <div className="flex items-center gap-1 text-[10px] sm:text-xs font-bold text-white/85">
        {highlight === "self"
          ? `★ ${label}`
          : label}
      </div>
      <div className="flex justify-center gap-1.5 flex-wrap">
        {hand.length === 0 ? (
          <BlackjackCardBack />
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
      <div
        className={`text-sm font-black ${
          busted
            ? "text-red-300"
            : didWin
            ? "text-amber-300"
            : isDraw
            ? "text-yellow-200"
            : "text-white/80"
        }`}
      >
        {scoreText}
      </div>
    </div>
  );
}

function MatchEndModal({
  t,
  stake,
  prizePaid,
  houseFee,
  winnerId,
  userId,
  result,
  onBackToLobby,
}: {
  t: TFn;
  stake: number;
  prizePaid: number;
  houseFee: number;
  winnerId: string | null;
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
  scorePlayer1,
  scorePlayer2,
  onAfter,
}: {
  t: TFn;
  matchId: number;
  nextRound: number;
  totalRounds: number;
  scorePlayer1: number;
  scorePlayer2: number;
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
