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

import { useCallback, useEffect, useMemo, useRef, useState, use } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { motion, AnimatePresence } from "framer-motion";
import { usePostHog } from "posthog-js/react";
import NavigationBar from "../../../../components/navigation-bar";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay and auto-starts when the match actually begins
// (leaves the waiting room), auto-stops when it finishes or the user
// quits. The waiting/matchmaking takeover stays OUTSIDE so nothing is
// recorded until real gameplay starts.
import CreatorModeHost from "../../../../components/creator-mode/CreatorModeHost";
import {
  CreatorView,
  CreatorModeShell,
  ShellMain,
  CreatorPhoneFrame,
} from "../../../../components/creator-mode/CreatorModeLayout";
import MatchWaiting from "../../../../components/lobby/MatchWaiting";
import IconAvatar from "../../../../components/IconAvatar";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import BlackjackCardBack from "../../../../components/BlackjackCardBack";
import ReportModal from "../../../../components/ReportModal";
import RoundMarkers from "../../../../components/casino/RoundMarkers";
import {
  playCardDraw,
  playVictory,
  playDefeat,
} from "../../../../lib/gameAudio";
import {
  IconFlag,
  IconHeartHandshake,
  IconTrophy,
  IconSkull,
  IconCrown,
  IconStarFilled,
  IconX,
  IconPlayerSkipForward,
  IconCards,
} from "@tabler/icons-react";
import {
  isRedSuit,
  SWAP_LIMIT_PER_ROUND,
  HOLD_LIMIT_PER_ROUND,
  PEEK_LIMIT_PER_ROUND,
  BETWEEN_ROUNDS_SECONDS,
  ROUND_TIMER_SECONDS,
  TOTAL_ROUNDS,
  TIEBREAK_ROUND_NUMBER,
} from "../../../../lib/blackjack-pvp/constants";
import { useTranslation } from "../../../../hooks/useTranslation";
import { useSocket } from "../../../../context/SocketProvider";
import {
  BLACKJACK_PVP_MATCH_UPDATED,
  blackjackPvpMatchRoom,
} from "../../../../lib/blackjack-pvp/rooms";
import EmotePicker, { EmoteArtwork } from "../../../../components/game/EmotePicker";

// ── Types ────────────────────────────────────────────────────────────
type Card = { suit: string; value: string };

type SeatActions = {
  swapsUsed: number;
  peeksUsed: number;
  holdsUsed: number;
  heldCard: Card | null;
  heldResolved: string | null;
};

type MatchState = {
  id: number;
  player1Id: string;
  player2Id: string | null;
  // Seat identity — real username / official icon / equipped name
  // color (battlepass glow > premium chat color), server-resolved.
  // Null for the AI seat; the client falls back to localized labels.
  player1Name: string | null;
  player1IconKey: string | null;
  player1NameColor: string | null;
  player2Name: string | null;
  player2IconKey: string | null;
  player2NameColor: string | null;
  isAi: boolean;
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
  // Present only on a finished DRAW (a tiebreak-round tie): both
  // players get the same refundEach back — 95% of their stake (5%
  // per-side rake).
  refundEach: number | null;
  roundTimer: number;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  player1UsedSwap: number;
  player2UsedSwap: number;
  player1UsedFreeze: number;
  player2UsedFreeze: number;
  // Peek counters mirror the freeze/swap collapse pattern: the
  // viewer sees their own raw count (0 or 1 in this build), and
  // the opponent's seat is collapsed to a boolean so peeking usage
  // can't leak through the wire.
  player1UsedPeek: number;
  player2UsedPeek: number;
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
// ── Dynamic-route params arrive async (Promise) on Next.js 15+/16. ─────
// BUG-FIX ("creating a game auto-redirects back to lobby") ───────────
// The original code synchronously read `params?.matchId`, which on
// Next.js 16 returns `undefined` (because the prop is a Promise, not
// a plain object). `Number(undefined) === NaN` flipped
// `isValidMatchId` to false, and the mount-effect below then
// router.push'd back to /casino/blackjack — losing the freshly
// created match the user had just escrowed a stake for, and never
// showing them the "waiting for opponent" waiting-room UI. The fix
// here mirrors the roulette match view: unwrap the Promise with
// React's `use()`, fall back to a null matchId on resolution, and
// keep the actual invalid-id redirect strictly for true bad URLs
// (e.g. /casino/blackjack/foo) — not for the legitimate async window.
export default function BlackjackPvpMatchPage({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();
  const { socket } = useSocket();
  const { t } = useTranslation();

  // Memoize a stable Promise wrapping the raw `params` prop so `use()`
  // can be called unconditionally on every render (React rules-of-
  // hooks). `Promise.resolve(p)` flattens when `params` is itself a
  // thenable; wraps a plain object on older Next.js so the call is
  // safe there too.
  const paramsPromise = useMemo(
    () => Promise.resolve(params),
    [params],
  );
  const resolvedParams = use(paramsPromise);
  const rawMatchId =
    resolvedParams && typeof resolvedParams === "object"
      ? resolvedParams.matchId
      : undefined;
  const numericMatchId = Number(rawMatchId);
  // `matchId` is `null` until params resolve and on truly malformed
  // URLs (e.g. /casino/blackjack/not-a-number). `isValidMatchId` is
  // only true for finite numeric ids — guarding both the API calls
  // below and the mount-effect redirect against the async window.
  const matchId = Number.isFinite(numericMatchId) ? numericMatchId : null;
  const isValidMatchId = matchId !== null;

  const [match, setMatch] = useState<MatchState | null>(null);
  const [rounds, setRounds] = useState<RoundRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [roundResultShownFor, setRoundResultShownFor] = useState<number | null>(
    null,
  );
  // Lifted swap-target state: clicking a card in MyHand now selects
  // which card the Swap action will replace (any index, not just the
  // two starting cards). Lives at the page so the same selection
  // drives both MyHand's highlight and ActionPanel's enabled state.
  const [swapTarget, setSwapTarget] = useState<number | null>(null);
  // Local peek overlay state. The server returns peekedCard in the
  // action response but does NOT persist it on the match row, so the
  // client manages visibility itself. Cleared whenever the player
  // commits to ANY other action (hit/swap/stand/hold/use_held).
  const [localPeekedCard, setLocalPeekedCard] = useState<Card | null>(null);
  // Report modal — flags the human opponent for moderation.
  const [showReportModal, setShowReportModal] = useState(false);
  const [incomingEmote, setIncomingEmote] = useState(null);
  const [myEmote, setMyEmote] = useState(null);
  // Resign flow — forfeits the match (opponent wins the pot) and
  // returns to the lobby. The confirmation modal guards the stake
  // loss so a stray tap can't throw the match away.
  const [showResignConfirm, setShowResignConfirm] = useState(false);
  const [resigning, setResigning] = useState(false);
  // Leave flow for free vs-AI matches — nothing is at stake, so leaving
  // just returns to the lobby (no resign API call).
  const [showAiLeave, setShowAiLeave] = useState(false);
  // Finished-state result overlay visibility — the shared
  // PvpResultScreen (UX plan P3-3) can be dismissed to reveal the
  // final revealed hands underneath.
  const [showResult, setShowResult] = useState(true);
  const victoryCelebratedRef = useRef(false);
  // Tracks which round numbers the user has already acknowledged in a
  // round-result modal. Without this, the modal would re-open on every
  // poll (because the latest-round-vs-shownFor check flips back to true
  // the moment the user dismisses).
  const acknowledgedRoundsRef = useRef<Set<number>>(new Set());
  const lastSeenMatchIdRef = useRef<number | null>(null);

  // Memo: my hand + opponent hand derived from viewerIsPlayer1.
  const viewerIsPlayer1 = Boolean(match?.viewerIsPlayer1);

  // Seat identity — real username + official Grynd icon + equipped name
  // color, resolved server-side (getMatchSeatIdentity). Null for the AI
  // seat; the labels fall back to the localized seat names below.
  const myIdentity = viewerIsPlayer1
    ? {
        name: match?.player1Name || null,
        iconKey: match?.player1IconKey || null,
        nameColor: match?.player1NameColor || null,
      }
    : {
        name: match?.player2Name || null,
        iconKey: match?.player2IconKey || null,
        nameColor: match?.player2NameColor || null,
      };
  const oppIdentity = match?.isAi
    ? { name: null, iconKey: null, nameColor: null }
    : viewerIsPlayer1
      ? {
          name: match?.player2Name || null,
          iconKey: match?.player2IconKey || null,
          nameColor: match?.player2NameColor || null,
        }
      : {
          name: match?.player1Name || null,
          iconKey: match?.player1IconKey || null,
          nameColor: match?.player1NameColor || null,
        };
  // The opponent is whoever occupies the seat we don't hold. Only
  // reportable once a real opponent has joined (player2Id set).
  const opponentClerkId = match?.isAi
    ? null
    : viewerIsPlayer1
      ? match?.player2Id ?? null
      : match?.player1Id ?? null;
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
          peeksUsed: match.player1UsedPeek,
          holdsUsed: match.player1UsedFreeze,
          heldCard: match.player1FrozenCard,
          heldResolved: match.player1HeldResolved,
        }
      : {
          swapsUsed: match.player2UsedSwap,
          peeksUsed: match.player2UsedPeek,
          holdsUsed: match.player2UsedFreeze,
          heldCard: match.player2FrozenCard,
          heldResolved: match.player2HeldResolved,
        }
    : {
        swapsUsed: 0,
        peeksUsed: 0,
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
          if (!opts?.silent) setErrorMsg(data?.error || t("blackjackPvp.errorMatchUnavailable", "Match unavailable"));
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
            next.status === "round_3" ||
            next.status === "round_4") &&
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
        if (!opts?.silent) setErrorMsg(t("blackjackPvp.errorNetwork", "Network error"));
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
    // Socket fanout below (BLACKJACK_PVP_MATCH_UPDATED) re-fetches on the
    // opponent's every action, so this HTTP poll is a reconnect/consistency
    // safety net. Held at 5s to minimize match-time DB reads; turn timing
    // comes from the server deadline + local clock, never from poll rate.
    const interval = setInterval(() => fetchStatus({ silent: true }), 5000);
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
    const handleEmote = (payload) => {
      if (payload?.senderId && payload.senderId === user?.id) return;
      setIncomingEmote(payload?.emote || null);
      // Mirror the 3s clear applied to my own emote bubble so the
      // opponent's bubble in the round-counter doesn't persist forever.
      window.setTimeout(() => setIncomingEmote(null), 3000);
    };
    socket.on("blackjack:emote", handleEmote);
    return () => {
      socket.emit("leave_room", { roomId: blackjackPvpMatchRoom(matchId) });
      socket.off(BLACKJACK_PVP_MATCH_UPDATED, refresh);
      socket.off("blackjack:emote", handleEmote);
    };
  }, [socket, matchId, isValidMatchId, fetchStatus]);

  // ── Player actions ────────────────────────────────────────────────
  const sendAction = useCallback(
    async (
      action:
        | "hit"
        | "stand"
        | "swap"
        | "hold"
        | "use_held"
        | "peek",
      payload?: Record<string, unknown>,
    ) => {
      if (!match) return;
      if (
        match.status !== "round_1" &&
        match.status !== "round_2" &&
        match.status !== "round_3" &&
        match.status !== "round_4"
      )
        return;
      if (submitting) return;
      // Auto-clear the local peek preview whenever the player commits
      // to any non-peek action. The peek strip is purely informational
      // and should disappear the instant the player makes a decision
      // (per spec: "if the player does an action after that like swap,
      // stand or hit, remove the div"). Peek itself leaves it intact so
      // the new preview can render/animate without flicker.
      if (action !== "peek" && localPeekedCard !== null) {
        setLocalPeekedCard(null);
      }
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
          setErrorMsg(data?.error || t("blackjackPvp.errorActionRejected", "Action rejected"));
          return;
        }
        if (action === "hit" && !data.data.justResolved) {
          playCardDraw();
        }
        if (action === "stand") playCardDraw();
        // Capture peeked card from action response. The server
        // returns this in `effect.peekedCard` rather than persisting
        // it (peek is a preview, not a state mutation).
        if (action === "peek") {
          const peekedCard = data?.data?.effect?.peekedCard;
          if (peekedCard && typeof peekedCard === "object") {
            setLocalPeekedCard({
              suit: String(peekedCard.suit ?? "?"),
              value: String(peekedCard.value ?? "?"),
            });
          }
        }
        await fetchStatus({ silent: true });
        socket?.emit("room_event", {
          roomId: blackjackPvpMatchRoom(matchId),
          event: BLACKJACK_PVP_MATCH_UPDATED,
        });
      } catch (e) {
        setErrorMsg(t("blackjackPvp.errorNetwork", "Network error"));
      } finally {
        setSubmitting(false);
      }
    },
    [match, matchId, submitting, socket, fetchStatus, localPeekedCard],
  );

  // ── Resign ─────────────────────────────────────────────────────────
  // Forfeits the match server-side: while waiting the stake is
  // refunded and the lobby cancelled; once an opponent has joined the
  // resigner forfeits their stake and the opponent is credited the pot
  // minus the house fee. Pings the opponent's live page via the match
  // room, then redirects straight back to the lobby.
  const handleResign = useCallback(async () => {
    if (resigning) return;
    setResigning(true);
    setShowResignConfirm(false);
    try {
      const res = await fetch(
        `/api/blackjack-pvp/match/${matchId}/resign`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        },
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        setErrorMsg(
          data?.error ||
            t(
              "blackjackPvp.resign.error",
              "Impossible d'abandonner",
            ),
        );
        return;
      }
      // Notify the opponent's page so they see the win instantly.
      socket?.emit("room_event", {
        roomId: blackjackPvpMatchRoom(matchId),
        event: BLACKJACK_PVP_MATCH_UPDATED,
      });
      // Also refresh the lobby list (a waiting lobby was cancelled).
      socket?.emit("room_event", {
        roomId: "lobby:blackjack-pvp",
        event: "lobby:updated",
      });
      router.push("/casino/blackjack");
    } catch (e) {
      setErrorMsg(t("blackjackPvp.errorNetwork", "Network error"));
    } finally {
      setResigning(false);
    }
  }, [matchId, resigning, socket, router, t]);

  // ── Round-result modal trigger ────────────────────────────────────
  // BUG-FIX (round-end modal closes itself on every 1.5s poll):
  //   `fetchStatus` calls `setRounds(data.data.rounds || [])` which
  //   creates a new array reference on every poll, re-firing this
  //   effect. With the OLD logic the trailing `setRoundResultShownFor(null)`
  //   ran unconditionally once the loop found no new unacknowledged
  //   round — i.e. immediately after the modal had just opened. That
  //   killed the modal ~1.5s after round-end, before the user could
  //   see the 6-phase reveal or the 5-second award header, so the
  //   user perceived the game as "skipping past the round result".
  //
  //   The only legitimate dismissal paths are now:
  //     1. The match finished/cancelled (status flip).
  //     2. The user pressing the modal's Continue / Skip / backdrop.
  //     3. The auto-dismiss timer inside RoundResultModal (5s).
  //   We no longer auto-clear `roundResultShownFor` from this hook.
  useEffect(() => {
    if (!match) return;
    // Only clear the modal on `cancelled` — on `finished`, the
    // deciding round's per-round popup should still surface (the
    // MatchEndModal is rendered separately and gated on
    // `roundResultShownFor === null` so it won't fight it).
    if (match.status === "cancelled") {
      setRoundResultShownFor(null);
      return;
    }
    if (roundResultShownFor !== null) return; // already showing — leave it open
    if (rounds.length === 0) return;
    for (let i = rounds.length - 1; i >= 0; i--) {
      const n = rounds[i].roundNumber;
      if (!acknowledgedRoundsRef.current.has(n)) {
        acknowledgedRoundsRef.current.add(n);
        setRoundResultShownFor(n);
        return;
      }
    }
  }, [match?.status, rounds, match, roundResultShownFor]);

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
      // Confetti is handled by the shared PvpResultScreen.
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
    match?.status === "round_3" ||
    match?.status === "round_4";

  // Real usernames when the server knows them; localized seat labels
  // as fallback (waiting lobby before a PvP opponent joins, or the AI
  // seat which has no users row).
  const mySeatLabel =
    myIdentity.name ||
    (viewerIsPlayer1
      ? t("blackjackPvp.seat.player1", "Joueur 1")
      : t("blackjackPvp.seat.player2", "Joueur 2"));
  const oppSeatLabel =
    oppIdentity.name ||
    (match?.isAi
      ? t("blackjackPvp.seat.ai", "GRYND AI")
      : t("blackjackPvp.seat.opponent", "Adversaire"));
  const myIconKey = myIdentity.iconKey;
  const oppIconKey = oppIdentity.iconKey;
  const myNameColor = myIdentity.nameColor;
  const oppNameColor = oppIdentity.nameColor;

  // Action gates (mirrors serverStore.applyAction):
  //   * STOOD is the ONLY state that locks the hand permanently.
  //   * BUSTED seats may still SWAP / HOLD / USE_HELD — those are
  //     the busted-recovery paths. HIT stays PLAYING-only because
  //     drawing another card can never un-bust you, but STAND is
  //     intentionally CLICKABLE at all times during the player's
  //     turn — including right after a SWAP/FREEZE that didn't
  //     recover the score (state still BUSTED) — so the player
  //     always has a clear way to finalise their turn from any
  //     non-stood state. The server is the authority: a STAND from
  //     a BUSTED seat is accepted and just no-ops (the round stays
  //     BUSTED for resolution since busted hands always lose anyway).
  // The server is authoritative: every gate below is also enforced
  // by recordAction, so a client-side mismatch just disables the
  // button — it doesn't open up an exploitation path.
  const handIsInteractive = isMyTurn && myState !== "stood";
  const canSwap =
    handIsInteractive &&
    myHand.length >= 2 &&
    (myActions.swapsUsed ?? 0) < SWAP_LIMIT_PER_ROUND;
  const canHold =
    handIsInteractive &&
    myHand.length >= 2 &&
    (myActions.holdsUsed ?? 0) < HOLD_LIMIT_PER_ROUND &&
    !myActions.heldCard;
  const canUseHeldAdd =
    handIsInteractive &&
    Boolean(myActions.heldCard) &&
    !myActions.heldResolved;
  const canUseHeldDiscard =
    handIsInteractive &&
    Boolean(myActions.heldCard) &&
    !myActions.heldResolved;
  // Peek is purely informational: available in PLAYING and BUSTED
  // states, gated only by the per-round cap. It does NOT consume a
  // round-ending action — the player still needs to HIT/STAND/SWAP/
  // HOLD to finalise their turn. The peeked preview itself only
  // appears in the local UI overlay (auto-cleared on the next
  // action) so the server doesn't need a card-persisted field.
  const canPeek =
    handIsInteractive &&
    (myActions.peeksUsed ?? 0) < PEEK_LIMIT_PER_ROUND;
  const canHit = isMyTurn && myState === "playing" && myScore < 21;
  // BUG-FIX (stand button unclickable after SWAP/FREEZE in Round
  // 2/3): The previous gate `isMyTurn && myState === "playing"` was
  // too restrictive — a SWAP that doesn't recover from BUSTED (the
  // fresh card still leaves score >21) leaves the server in
  // `busted`, so the Stand button stayed disabled even though the
  // round keeps ticking. Allow the button at all times during the
  // player's turn so they can finalise regardless of state. The
  // server's `applyAction` STAND gate already permits BUSTED → STOOD
  // because STOOD is functionally equivalent for a busted hand
  // (effectiveHandScore sentinel guarantees a busted hand loses).
  const canStand = handIsInteractive;

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
      case "round_4":
        return t("blackjackPvp.status.activePlay", "En jeu");
      case "finished":
        if (match.result === "draw")
          return t(
            "blackjackPvp.status.finishedDraw",
            "Égalité. Mise remboursée",
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

  // ── Result screen — shared PvpResultScreen (UX plan P3-3) ───────
  // Rendered when the match finishes — AFTER the deciding round's
  // per-round popup is dismissed (same sequencing as the old
  // MatchEndModal it replaces, so the two overlays never stack).
  // Every number comes from the real match row (winner / prizePaid /
  // houseFee / refundEach / rounds / startedAt→endedAt) — nothing is
  // invented. Winner/payout logic is untouched.
  function renderMatchEnd() {
    if (!match || match.status !== "finished" || !showResult) return null;
    // Wait for the deciding round's RoundResultModal to be dismissed.
    if (roundResultShownFor !== null) return null;

    const isAi = Boolean(match.isAi);
    const won = Boolean(match.winner) && user?.id === match.winner;
    const draw = match.result === "draw";
    const outcome = draw ? "draw" : won ? "win" : "loss";

    const stake = Number(match.stakeAmount ?? 0);
    const prizePaid = Number(match.prizePaid ?? 0);
    const houseFee = Number(match.houseFee ?? 0);
    const refundEach = Number(match.refundEach ?? 0);
    const pot = stake * 2;
    const myRounds = viewerIsPlayer1
      ? Number(match.roundsWonPlayer1 || 0)
      : Number(match.roundsWonPlayer2 || 0);
    const oppRounds = viewerIsPlayer1
      ? Number(match.roundsWonPlayer2 || 0)
      : Number(match.roundsWonPlayer1 || 0);

    // Stake is escrowed at matchmaking; at settle the winner is
    // credited `prizePaid` (= pot − 5% fee = 1.9 × stake, stake
    // included). Net token change from the viewer's pocket:
    //   win  → +prizePaid − stake = +0.9 × stake
    //   loss → −stake
    //   draw → +refundEach (95% of stake — 5% rake per side on the
    //          tiebreak tie)
    // AI practice matches never move tokens.
    const tokenDelta = isAi
      ? null
      : draw
        ? refundEach
        : won
          ? prizePaid - stake
          : -stake;

    // Duration from the existing timestamps (omitted when unavailable).
    let durationSeconds: number | null = null;
    if (match.startedAt && match.endedAt) {
      const start = new Date(match.startedAt).getTime();
      const end = new Date(match.endedAt).getTime();
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        durationSeconds = Math.round((end - start) / 1000);
      }
    }

    const oppName = isAi ? "GRYND AI" : oppSeatLabel;
    const headline = won
      ? `You took the match ${myRounds}–${oppRounds} rounds`
      : draw
        ? "Evenly matched — the tiebreak round couldn't split you"
        : `${oppName} took the match ${oppRounds}–${myRounds} rounds`;
    const subline = isAi
      ? "Free practice match — no tokens were staked or awarded."
      : draw
        ? `Tiebreak round tied. Both players refunded ${refundEach.toFixed(2)} (95%, 5% platform fee each).`
        : won
          ? `Your ${stake.toFixed(2)} stake back plus ${(prizePaid - stake).toFixed(2)} in winnings.`
          : `You lost your ${stake.toFixed(2)} stake. Platform fee: ${houseFee.toFixed(2)}.`;

    return (
      <PvpResultScreen
        open
        compact
        outcome={outcome}
        headline={headline}
        subline={subline}
        gameName="Blackjack PvP"
        opponent={{ name: oppName, iconKey: oppIconKey, isAi }}
        tokenDelta={tokenDelta}
        durationSeconds={durationSeconds}
        summary={[
          {
            label: "Result",
            value: outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : "Draw",
          },
          { label: "Rounds", value: `${myRounds} – ${oppRounds}` },
        ]}
        details={[
          { label: "Match ID", value: String(match.id) },
          ...(isAi
            ? []
            : [
                { label: "Stake", value: `${stake.toLocaleString()} tokens` },
                { label: "Pot", value: `${pot.toLocaleString()} tokens` },
                ...(won
                  ? [
                      { label: "Prize paid", value: `${prizePaid.toLocaleString()} tokens` },
                      { label: "Platform fee", value: `${houseFee.toLocaleString()} tokens` },
                    ]
                  : []),
              ]),
          { label: "Winner", value: draw ? "Draw" : won ? "You" : oppName },
        ]}
        detailsContent={
          rounds.length > 0 ? (
            <div className="mt-3">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-white/40">
                Round scores
              </p>
              <div className="space-y-1">
                {rounds.map((r) => {
                  const myScore = viewerIsPlayer1
                    ? r.player1Score
                    : r.player2Score;
                  const oppScore = viewerIsPlayer1
                    ? r.player2Score
                    : r.player1Score;
                  const viewerWonRound = r.viewerWonThisRound === true;
                  return (
                    <div
                      key={r.id}
                      className="flex items-center justify-between"
                    >
                      <span className="text-white/50">
                        Round {r.roundNumber}
                      </span>
                      <span
                        className={
                          viewerWonRound
                            ? "font-bold text-emerald-300"
                            : "text-white/60"
                        }
                      >
                        {myScore} – {oppScore}
                        {viewerWonRound ? " ✓" : " ✗"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null
        }
        playAgain={{ label: "RUN IT BACK", onClick: () => router.push("/casino/blackjack") }}
        onReturnToLobby={() => router.push("/casino")}
        onDismiss={() => setShowResult(false)}
        dismissLabel="View Match Results"
      />
    );
  }

  // ── Creator-mode layout nodes ─────────────────────────────────────
  // The game content is split into reusable nodes so the normal page
  // (non-creator) renders byte-for-byte the same, while Creator Mode
  // gets a bespoke arrangement: portrait = phone-style (compact header,
  // the table filling the middle, controls pinned at the bottom);
  // landscape/square = the table fills the frame height with controls
  // in a right rail.

  // Header — title, stake chip, report + leave/resign (desktop layout).
  const headerNode = (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-2xl sm:text-3xl font-bold text-[#FFD700] drop-shadow-[0_0_10px_rgba(255,215,0,0.4)]">
        <span className="inline-flex items-center gap-2"><IconCards size={26} className="text-[#FFD700]" /> {t("blackjackPvp.title", "Blackjack PvP")}</span>
      </h1>
      <span className="px-4 py-1.5 bg-[#FFD700]/15 border border-[#FFD700]/40 text-[#fffec7] rounded-full font-extrabold text-sm shadow-[0_0_10px_rgba(255,215,0,0.3)]">
        {match?.isAi
          ? t("blackjackPvp.freeMatch", "Free AI match")
          : t("blackjackPvp.stake", "Mise : {amount}").replace(
              "{amount}",
              Number(match?.stakeAmount ?? 0).toLocaleString(),
            )}
      </span>
      {!match?.isAi && opponentClerkId && (
        <button
          onClick={() => setShowReportModal(true)}
          className="px-3 py-1.5 rounded-full border border-red-500/30 bg-red-500/10 text-xs font-extrabold text-red-400 transition-all hover:bg-red-500/20 hover:shadow-[0_0_10px_rgba(239,68,68,0.3)]"
        >
          <span className="inline-flex items-center gap-1"><IconFlag size={12} /> Report opponent</span>
        </button>
      )}

      {/* Leave / Resign — kept in the top header so it stays
          reachable even when the portrait creator frame crops the
          tall content column. PvP matches resign (stake forfeit)
          via the resign API; free vs-AI matches just leave —
          nothing is at stake. Hidden while waiting (owner uses
          Cancel) and once the match reaches a terminal state. */}
      {match &&
        match.status !== "waiting" &&
        match.status !== "finished" &&
        match.status !== "cancelled" && (
          <button
            onClick={() =>
              match.isAi
                ? setShowAiLeave(true)
                : setShowResignConfirm(true)
            }
            disabled={resigning}
            className={`px-3 py-1.5 rounded-full border text-xs font-extrabold transition-all hover:shadow-[0_0_10px_rgba(239,68,68,0.3)] disabled:opacity-40 ${
              match.isAi
                ? "border-cyan-400/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20"
                : "border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20"
            }`}
          >
            {match.isAi
              ? t("blackjackPvp.leave.button", "Leave match")
              : t("blackjackPvp.resign.button", "Resign")}
          </button>
        )}
    </div>
  );

  // Compact header for the creator frames — same actions, tighter
  // typography so the table gets the vertical space.
  const creatorHeaderNode = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-lg font-bold text-[#FFD700] drop-shadow-[0_0_10px_rgba(255,215,0,0.4)]">
        <span className="inline-flex items-center gap-2"><IconCards size={20} className="text-[#FFD700]" /> {t("blackjackPvp.title", "Blackjack PvP")}</span>
      </h1>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="px-2.5 py-1 bg-[#FFD700]/15 border border-[#FFD700]/40 text-[#fffec7] rounded-full font-extrabold text-[11px] shadow-[0_0_10px_rgba(255,215,0,0.3)]">
          {match?.isAi
            ? t("blackjackPvp.freeMatch", "Free AI match")
            : t("blackjackPvp.stake", "Mise : {amount}").replace(
                "{amount}",
                Number(match?.stakeAmount ?? 0).toLocaleString(),
              )}
        </span>
        {!match?.isAi && opponentClerkId && (
          <button
            onClick={() => setShowReportModal(true)}
            className="px-2.5 py-1 rounded-full border border-red-500/30 bg-red-500/10 text-[11px] font-extrabold text-red-400 transition-all hover:bg-red-500/20"
          >
            <span className="inline-flex items-center gap-1"><IconFlag size={11} /> Report</span>
          </button>
        )}
        {match &&
          match.status !== "waiting" &&
          match.status !== "finished" &&
          match.status !== "cancelled" && (
            <button
              onClick={() =>
                match.isAi
                  ? setShowAiLeave(true)
                  : setShowResignConfirm(true)
              }
              disabled={resigning}
              className={`px-2.5 py-1 rounded-full border text-[11px] font-extrabold transition-all hover:shadow-[0_0_10px_rgba(239,68,68,0.3)] disabled:opacity-40 ${
                match.isAi
                  ? "border-cyan-400/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20"
                  : "border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20"
              }`}
            >
              {match.isAi
                ? t("blackjackPvp.leave.button", "Leave match")
                : t("blackjackPvp.resign.button", "Resign")}
            </button>
          )}
      </div>
    </div>
  );

  const errorNode = errorMsg ? (
    <div className="mb-3 bg-red-500/10 border border-red-500/30 text-red-400 p-2 rounded text-sm text-center">
      {errorMsg}
    </div>
  ) : null;

  // The game table itself — status banner + both hands + the round
  // scoreboard + held-card preview + between-rounds + peek strip.
  const tableNode = (
    <>
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
        iconKey={oppIconKey}
        nameColor={oppNameColor}
        hand={oppHand}
        isMatchFinished={match?.status === "finished"}
        isAi={Boolean(match?.isAi)}
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
        // During the round-4 TIEBREAK the chip reads "Round 4/4"
        // (roundNumber exceeds the best-of-3 ceiling).
        totalRounds={Math.max(
          TOTAL_ROUNDS,
          match?.roundNumber ?? 1,
        )}
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
        myNameColor={myNameColor}
        oppNameColor={oppNameColor}
        myEmote={myEmote}
        incomingEmote={incomingEmote}
      />

      {/* ▶ BOTTOM SECTION — You
          Face-up cards + my score (with bust / stood states
          surfaced through the same MyHand component). The
          `canSwap` + `swapTarget` props wire click-to-select
          card highlighting into MyHand so the swap target picks
          up via card click instead of the (now-removed) 1st/2nd
          pill — swap itself still routes through ActionPanel. */}
      <MyHand
        t={t}
        label={mySeatLabel}
        iconKey={myIconKey}
        nameColor={myNameColor}
        hand={myHand}
        myState={myState}
        score={myScore}
        canSwap={canSwap}
        swapTarget={swapTarget}
        onSwapTargetChange={setSwapTarget}
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
          // The tiebreak transition holds roundNumber=4, which IS
          // the upcoming round — cap the advertisement at round 4
          // so it never reads "Round 5/4" (regular transitions
          // keep the existing roundNumber+1 behaviour).
          nextRound={
            Number(match.roundNumber) + 1 > TIEBREAK_ROUND_NUMBER
              ? TIEBREAK_ROUND_NUMBER
              : Number(match.roundNumber) + 1
          }
          totalRounds={Math.max(
            TOTAL_ROUNDS,
            Number(match.roundNumber) + 1 > TIEBREAK_ROUND_NUMBER
              ? TIEBREAK_ROUND_NUMBER
              : Number(match.roundNumber) + 1,
          )}
          roundsWonPlayer1={Number(match.roundsWonPlayer1) || 0}
          roundsWonPlayer2={Number(match.roundsWonPlayer2) || 0}
          onAfter={fetchStatus}
        />
      )}

      {/* Animated Peek strip — sits BETWEEN the player's hand and
          the action buttons so the player sees the next card on
          the shoe right where they're deciding. Enter/exit
          animations are driven by `localPeekedCard` being set or
          cleared; clearing happens automatically inside
          `sendAction` whenever the player commits to a non-peek
          verb (HIT/SWAP/STAND/HOLD/USE_HELD). */}
      <AnimatePresence>
        {localPeekedCard && (
          <PeekOverlay t={t} card={localPeekedCard} />
        )}
      </AnimatePresence>
    </>
  );

  // Action controls — timer, Hit/Stand/Swap/Freeze/Peek + emotes,
  // plus the turn-state hints and waiting/ready banners.
  const controlsNode = (
    <>
      {/* Action buttons — visible for both PLAYING (full move
          set) and BUSTED (recovery via Swap / Freeze / Use-Held)
          seats. Hit and Stand appear but stay disabled on busted
          seats because they can't un-bust you. */}
      {handIsInteractive && (
        <>
          <RoundTimerDisplay
            t={t}
            deadline={match?.roundDeadline ?? null}
            total={ROUND_TIMER_SECONDS}
          />
          <ActionPanel
            t={t}
            submitting={submitting}
            canHit={canHit}
            canStand={canStand}
            canSwap={canSwap && swapTarget !== null}
            canHold={canHold}
            canPeek={canPeek}
            canUseHeldAdd={canUseHeldAdd}
            canUseHeldDiscard={canUseHeldDiscard}
            swapTarget={swapTarget}
            onHit={() => sendAction("hit")}
            onStand={() => sendAction("stand")}
            onSwap={() => swapTarget !== null && sendAction("swap", { swapIndex: swapTarget })}
            onHold={() => sendAction("hold")}
            onPeek={() => sendAction("peek")}
            onUseHeldAdd={() =>
              sendAction("use_held", { subaction: "add" })
            }
            onUseHeldDiscard={() =>
              sendAction("use_held", { subaction: "discard" })
            }
          />
          <div className="mt-2 flex justify-center">
            <EmotePicker
              compact
              hideBubbles
              incomingEmote={incomingEmote}
              myEmote={myEmote}
              onSend={(emote) => {
                setMyEmote(emote);
                socket?.emit("room_event", {
                  roomId: blackjackPvpMatchRoom(matchId),
                  event: "blackjack:emote",
                  payload: { emote, senderId: user?.id },
                });
                window.setTimeout(() => setMyEmote(null), 3000);
              }}
            />
          </div>
        </>
      )}
      {/* STOOD lock: the hand is frozen and the round resolves
          as soon as BOTH seats leave PLAYING. We surface ONE
          consolidated hint here — the previous build had a
          second duplicate render that just stacked with this
          one, which read as visual noise. */}
      {isMyTurn && myState === "stood" && (
        <div className="mt-3 text-center text-xs text-white/55 italic">
          {t(
            "blackjackPvp.lockedAfterStand",
            "Hand locked. Both hands reveal when the round ends.",
          )}
        </div>
      )}
      {/* Busted-but-still-active hint — clarifies that the
          player can still use Swap & Freeze to recover before
          the round resolves (the panel above stays visible).
          The two halves are independently translated so fr/es
          players don't see English glue text. */}
      {myState === "busted" && handIsInteractive && (
        <div className="mt-2 text-center text-xs">
          <span className="text-amber-200 font-bold uppercase tracking-wider">
            {t("blackjackPvp.bustedPrefix", "Busted!")}
          </span>{" "}
          <span className="text-white/75">
            {t(
              "blackjackPvp.bustedRecoverHint",
              "Swap or freeze to recover.",
            )}
          </span>
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
    </>
  );

  // Round-by-round history footer — abstract win/loss only;
  // opponent cards+score are scrubbed server-side.
  const historyNode =
    rounds.length > 0 ? (
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
                    "Manche {n}, {me}: {myScore}{meTag} vs {opp}: {oppScore}{oppTag}",
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
    ) : null;

  // Round-end popup + cancelled modal (fixed overlays — rendered in
  // every view so recordings capture the same game feedback).
  const modalsNode = (
    <>
      {/* Round-end popup — pops for ~5s after each resolved round to
         celebrate the round winner (with their seat label + the
         updated best-of-3 score, e.g. "Joueur 1 wins Round 2 (1-0)").
         Both hands + both scores are revealed because the round is
         no longer secret once it has resolved server-side. */}
      <AnimatePresence>
        {roundResultShownFor !== null &&
          (() => {
            const round = rounds.find(
              (r) => r.roundNumber === roundResultShownFor,
            );
            if (!round || !match) return null;
            return (
              <RoundResultModal
                key={`round-${round.roundNumber}-${round.id}`}
                t={t}
                round={round}
                viewerIsPlayer1={viewerIsPlayer1}
                mySeatLabel={mySeatLabel}
                oppSeatLabel={oppSeatLabel}
                isAi={Boolean(match.isAi)}
                roundsWonPlayer1={Number(match.roundsWonPlayer1) || 0}
                roundsWonPlayer2={Number(match.roundsWonPlayer2) || 0}
                onDismiss={() => setRoundResultShownFor(null)}
              />
            );
          })()}
      </AnimatePresence>

      {/* Match cancelled modal (unchanged) */}
      <AnimatePresence>
        {match?.status === "cancelled" && (
          <CancelledModal
            t={t}
            onBackToLobby={() => router.push("/casino/blackjack")}
          />
        )}
      </AnimatePresence>
    </>
  );

  // Normal (non-creator) page — byte-for-byte the original stack.
  const normalView = (
    <>
      <div className="mx-auto max-w-5xl px-3 py-4 sm:px-4 sm:py-6">
        {headerNode}
        {errorNode}
        <div className="rounded-2xl border border-[#FFD700]/25 bg-gradient-to-br from-[#001933]/90 via-[#00111f]/90 to-[#000814]/90 shadow-[0_0_30px_rgba(255,215,0,0.12)] p-4 sm:p-6">
          {tableNode}
          {controlsNode}
        </div>
        {historyNode}
      </div>
      {modalsNode}
    </>
  );

  // The game renders inside a phone-width viewport (390px) that is
  // `zoom`ed up to fill the frame — exactly how <CreatorResponsiveLayout>
  // makes the generic games look like a real phone. Blackjack's cards and
  // buttons are fixed-size (80×112px cards, ~36px buttons), so rendered
  // directly in the wide frame they read as tiny; at phone width they are
  // the real mobile sizes, then zoomed 2.77× (portrait) / 1.56×
  // (landscape) → big and readable. Layout stays: compact header, table
  // filling the middle (scrolls), controls + history pinned below.
  const creatorGameNode = (
    <>
      <div className="shrink-0">{creatorHeaderNode}</div>
      {errorNode}
      <div className="mt-2 flex-1 min-h-0 overflow-y-auto rounded-2xl border border-[#FFD700]/25 bg-gradient-to-br from-[#001933]/90 via-[#00111f]/90 to-[#000814]/90 shadow-[0_0_30px_rgba(255,215,0,0.12)] p-3">
        {tableNode}
      </div>
      <div className="mt-2 shrink-0 space-y-2">
        {controlsNode}
        {historyNode && (
          <div className="max-h-[110px] overflow-y-auto">{historyNode}</div>
        )}
      </div>
    </>
  );

  // Portrait (9:16) — phone screen filling the frame edge-to-edge.
  const portraitContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellMain className="overflow-hidden">
        <CreatorPhoneFrame>{creatorGameNode}</CreatorPhoneFrame>
      </ShellMain>
      {modalsNode}
    </CreatorModeShell>
  );

  // Landscape (16:9) / square (1:1) — the same phone screen, fitted and
  // centered inside the frame (ShellMain centers its children).
  const landscapeContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellMain className="overflow-hidden">
        <CreatorPhoneFrame>{creatorGameNode}</CreatorPhoneFrame>
      </ShellMain>
      {modalsNode}
    </CreatorModeShell>
  );

  // ── Main render ───────────────────────────────────────────────────
  return (
    <>
      {/* Unified full-screen waiting takeover (matchmaking → countdown) */}
      {(match?.status === "waiting" || match?.status === "ready") && (
        <MatchWaiting
          state={match.status === "ready" ? "ready" : "waiting"}
          gameName={match?.isAi ? "Blackjack vs AI" : "Blackjack PvP"}
          subtitle={
            match.status === "ready"
              ? "Round 1 starts in a moment…"
              : match?.isAi
                ? "Free practice against the GRYND AI — the hand starts in a moment."
                : "Your stake is escrowed. Someone with the same stake will join shortly."
          }
          seats={
            match.status === "waiting"
              ? [
                  { label: "You", name: mySeatLabel || "You", occupied: true },
                  {
                    label: match?.isAi ? "GRYND AI" : "Opponent",
                    occupied: false,
                  },
                ]
              : []
          }
          onCancel={
            match.status === "waiting" && match?.player1Id === user?.id
              ? async () => {
                  await fetch(
                    `/api/blackjack-pvp/match/${matchId}/cancel`,
                    { method: "POST", credentials: "include" },
                  );
                  socket?.emit("room_event", {
                    roomId: "lobby:blackjack-pvp",
                    event: "lobby:updated",
                  });
                  router.push("/casino/blackjack");
                }
              : null
          }
          cancelLabel="Cancel lobby"
        />
      )}

      <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] pb-24 pt-20 text-white md:pb-8">
      <NavigationBar currentPath="/casino" />
      {/* Only the actual game content is recorded — the matchmaking
          takeover above and the modals below sit outside the shared
          CreatorModeHost recording viewport. Recording auto-starts when
          the match leaves waiting and stops when it finishes/cancels. */}
      <CreatorModeHost
        autoStart={Boolean(match) && match.status !== "waiting"}
        autoStop={
          match?.status === "finished" || match?.status === "cancelled"
        }
        gameLabel="blackjack"
        backToLobbyHref="/casino/blackjack"
      >
      <CreatorView
        normal={normalView}
        portrait={portraitContent}
        landscape={landscapeContent}
      />

      {/* Post-match result screen — shared PvpResultScreen (UX plan
          P3-3). Mounted INSIDE CreatorModeHost so it appears in the
          recording; compact styling keeps it sized for the phone frame. */}
      {renderMatchEnd()}
      </CreatorModeHost>

      {/* Resign confirmation modal — warns the player their stake is
          forfeited before hitting the resign API. */}
      <AnimatePresence>
        {showResignConfirm && match && (
          <ResignConfirmModal
            t={t}
            stake={Number(match.stakeAmount)}
            busy={resigning}
            onCancel={() => setShowResignConfirm(false)}
            onConfirm={handleResign}
          />
        )}
        {showAiLeave && match?.isAi && (
          <LeaveAiConfirmModal
            t={t}
            onCancel={() => setShowAiLeave(false)}
            onConfirm={() => router.push("/casino/blackjack")}
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

      {/* Report modal */}
      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: opponentClerkId,
              gameType: "blackjack",
              gameId: String(matchId),
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName="Opponent"
        gameType="Blackjack PvP"
      />
      </div>
    </>
  );
}

// ── Per-round 30-second countdown chip ───────────────────────────────
// Renders `30s … 0s` over a thin progress bar above the action
// panel. Local-to-the-viewer state ticks every 500 ms so the bar
// stays smooth between the 1.5 s server polls. Colour flips from
// gold → red and the label switches to the urgent variant at ≤5 s,
// matching the `roundTimerUrgent` translation key.
function RoundTimerDisplay({
  t,
  deadline,
  total,
}: {
  t: TFn;
  deadline: string | null;
  total: number;
}) {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  if (!deadline) return null;
  const deadlineMs = new Date(deadline).getTime();
  if (!Number.isFinite(deadlineMs)) return null;

  const secondsLeft = Math.max(0, Math.ceil((deadlineMs - now) / 1000));
  const progress = Math.max(
    0,
    Math.min(1, secondsLeft / Math.max(1, total)),
  );
  // Fold the "expired" state into urgent so the panel keeps pulsing
  // while we wait for the server's force-advance / round-resolve
  // sweep. Otherwise the user sees a flat zero that doesn't change
  // until the next 1.5s poll lands.
  const urgent = secondsLeft <= 5;
  const labelKey = urgent
    ? "blackjackPvp.roundTimerUrgent"
    : "blackjackPvp.roundTimer";
  const fallback = urgent ? "{seconds}s, act now" : "{seconds}s";
  const label = t(labelKey, fallback).replace(
    "{seconds}",
    String(secondsLeft),
  );

  return (
    <div className="mt-3 mb-1 text-center" aria-live="polite">
      <div
        className={`text-3xl sm:text-4xl font-black leading-none transition-colors ${
          urgent ? "text-red-300 animate-pulse" : "text-[#FFD700]"
        }`}
      >
        {label}
      </div>
      <div className="mt-1.5 h-1.5 w-full bg-white/10 rounded-full overflow-hidden shadow-inner">
        <motion.div
          initial={false}
          animate={{ width: `${progress * 100}%` }}
          transition={{ duration: 0.4, ease: "linear" }}
          className={`h-full ${urgent ? "bg-red-400" : "bg-[#FFD700]"}`}
        />
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────
function OpponentHand({
  t,
  label,
  iconKey,
  nameColor,
  hand,
  isMatchFinished,
  isAi,
}: {
  t: TFn;
  label: string;
  iconKey?: string | null;
  nameColor?: string | null;
  hand: Card[];
  isMatchFinished: boolean;
  isAi: boolean;
}) {
  // By spec the opponent's cards, score, and state are NEVER shown.
  const placeholder = isAi
    ? t("blackjackPvp.aiPlaying", "GRYND AI is playing…")
    : isMatchFinished
      ? t("blackjackPvp.opponentDone", "Adversaire. Main cachée")
      : t("blackjackPvp.opponentPlaying", "Adversaire joue…");
  return (
    <div>
      <div className="text-center mb-2">
        <div className="flex items-center justify-center gap-2">
          <IconAvatar
            iconKey={iconKey || null}
            name={label}
            size="h-10 w-10"
            className="border border-[#FFD700]/40"
          />
          <h2
            className="text-[#FFD700]/80 text-sm font-semibold"
            style={nameColor ? { color: nameColor } : undefined}
          >
            {label}
          </h2>
        </div>
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
  iconKey,
  nameColor,
  hand,
  myState,
  score,
  canSwap,
  swapTarget,
  onSwapTargetChange,
}: {
  t: TFn;
  label: string;
  iconKey?: string | null;
  nameColor?: string | null;
  hand: Card[];
  myState: string;
  score: number;
  // `canSwap` flips the cards into click-targets that highlight and
  // bounce up when selected. Selection is managed by the parent and
  // rounded-tripped through ActionPanel's Swap dispatch.
  canSwap: boolean;
  swapTarget: number | null;
  onSwapTargetChange: (idx: number) => void;
}) {
  const busted = myState === "busted" && hand.length > 0;
  return (
    <div>
      <div className="text-center mb-2">
        <div className="flex items-center justify-center gap-2">
          <IconAvatar
            iconKey={iconKey || null}
            name={label}
            size="h-9 w-9"
            className="border border-[#FFD700]/40"
          />
          <h2
            className="text-[#FFD700] text-sm font-bold"
            style={nameColor ? { color: nameColor } : undefined}
          >
            {label} ({t("blackjackPvp.you", "vous")})
          </h2>
        </div>
        {hand.length > 0 && (
          <p
            className={`text-xs mt-0.5 font-bold ${
              busted ? "text-red-400" : "text-[#FFD700]/80"
            }`}
          >
            {busted
              ? `${t("blackjackPvp.bustedPrefix", "Vous avez sauté !")} (${score})`
              : myState === "stood"
              ? `${t("blackjackPvp.stand", "Rester")} (${score} ${t("blackjackPvp.ptsUnit", "pts")})`
              : `${score} ${t("blackjackPvp.ptsUnit", "pts")}`}
          </p>
        )}
      </div>
      <div className="flex justify-center gap-3 mb-1 flex-wrap">
        {hand.length === 0 ? (
          [0, 1].map((i) => <BlackjackCardBack key={i} />)
        ) : (
          hand.map((card, i) => {
            const isSelected = canSwap && swapTarget === i;
            return (
              <motion.button
                key={i}
                type="button"
                disabled={!canSwap}
                onClick={() => {
                  if (canSwap) onSwapTargetChange(i);
                }}
                initial={{ y: 60, opacity: 0 }}
                animate={
                  isSelected
                    ? { y: -22, opacity: 1, scale: 1.08 }
                    : { y: 0, opacity: 1, scale: 1 }
                }
                whileHover={
                  canSwap && !isSelected
                    ? { y: -8, scale: 1.04 }
                    : undefined
                }
                whileTap={canSwap ? { scale: 0.97 } : undefined}
                transition={{ type: "spring", stiffness: 380, damping: 28 }}
                aria-label={`Card ${i + 1}: ${card.suit}${card.value}${isSelected ? " (selected for swap)" : ""}`}
                className={`relative focus:outline-none ${
                  busted ? "animate-shake" : ""
                }`}
                style={{
                  filter: isSelected
                    ? "drop-shadow(0 0 14px rgba(168,85,247,0.55))"
                    : undefined,
                }}
              >
                <CardFace card={card} />
                {isSelected && (
                  <motion.span
                    initial={{ opacity: 0, scale: 0.7, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    transition={{ type: "spring", stiffness: 420, damping: 22 }}
                    className="absolute -top-3 -right-3 rounded-full bg-purple-500 text-white text-[10px] font-extrabold px-2 py-0.5 shadow-[0_0_10px_rgba(168,85,247,0.7)] uppercase tracking-widest"
                  >
                    {t("blackjackPvp.swapSelectedBadge", "Swap")}
                  </motion.span>
                )}
              </motion.button>
            );
          })
        )}
      </div>
      {/* ── Swap-selection hint row: surfaces "click a card" guidance
          while the player has an unused swap, and disappears once a
          card is chosen (ActionPanel's button-enabled state already
          mirrors this). The hint text is fully localizable via the
          existing blackjackPvp.* translation bundle. */}
      {canSwap && swapTarget === null && (
        <div className="text-center text-xs text-purple-200/80 mt-1 italic">
          {t(
            "blackjackPvp.swapPickHint",
            "Click any card to mark it for swap",
          )}
        </div>
      )}
      {canSwap && swapTarget !== null && (
        <div className="text-center text-xs text-purple-200 mt-1 italic">
          {t(
            "blackjackPvp.swapChosenHint",
            "Card #{n} marked. Press Swap to draw a random replacement",
          ).replace("{n}", String(swapTarget + 1))}
        </div>
      )}
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
  canPeek,
  canUseHeldAdd,
  canUseHeldDiscard,
  swapTarget,
  onHit,
  onStand,
  onSwap,
  onHold,
  onPeek,
  onUseHeldAdd,
  onUseHeldDiscard,
}: {
  t: TFn;
  submitting: boolean;
  canHit: boolean;
  canStand: boolean;
  // canSwap is parent-supplied as `canSwap && swapTarget !== null`
  // so the button naturally stays disabled until the player has
  // clicked a card in MyHand. This replaces the inline 1st / 2nd
  // pill that used to live here.
  canSwap: boolean;
  canHold: boolean;
  canPeek: boolean;
  canUseHeldAdd: boolean;
  canUseHeldDiscard: boolean;
  swapTarget: number | null;
  onHit: () => void;
  onStand: () => void;
  onSwap: () => void;
  onHold: () => void;
  onPeek: () => void;
  onUseHeldAdd: () => void;
  onUseHeldDiscard: () => void;
}) {
  // Hit / Stand / Swap / Freeze / Peek — the five core gameplay
  // buttons per the redesigned layout. The swap-target is now a
  // lifted parent-owned value driven by card clicks in MyHand, so
  // there is no local pill here.
  const baseBtn =
    "px-4 py-2.5 rounded-xl font-bold text-sm transition disabled:opacity-40 disabled:cursor-not-allowed border-b-2";
  const busy = submitting ? "…" : null;

  const swapDisabled = !canSwap || submitting;
  const swapTitle =
    swapTarget === null
      ? t(
          "blackjackPvp.swapHintPick",
          "Click a card first, then press Swap",
        )
      : t(
          "blackjackPvp.swapHintRandom",
          "Replace card #{n} with a random draw from the shoe",
        ).replace("{n}", String(swapTarget + 1));

  return (
    <div className="mt-4 space-y-2.5">
      {/* ── Hit / Stand / Swap / Freeze / Peek — 5-button row */ }
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
          onClick={onSwap}
          disabled={swapDisabled}
          title={swapTitle}
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
        <button
          onClick={onPeek}
          disabled={!canPeek || submitting}
          title={t(
            "blackjackPvp.peekHint",
            "Peek at the top of the shoe: the next card you'd HIT",
          )}
          className={`${baseBtn} border-indigo-400/45 bg-indigo-500/15 text-indigo-100 hover:bg-indigo-500/25 shadow-[0_0_10px_rgba(99,102,241,0.35)]`}
        >
          {busy ?? t("blackjackPvp.peek", "Peek")}
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

// ── Peek overlay — animated reveal of the top of the shoe ───────────
// Renders between MyHand and ActionPanel only when the player holds a
// freshly-peeked card in client-side state. The flip animation visually
// distinguishes peek from hit (which uses a falling-card slide) and the
// AnimatePresence wrapper on the parent handles the exit animation
// when the next action commits. Card values are never broadcast to
// anyone other than the peeking client — the server scrubs
// `match.deck[0]` from any opponent-flavoured payload.
function PeekOverlay({
  t,
  card,
}: {
  t: TFn;
  card: Card;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="mb-3 flex items-center justify-center"
      role="status"
      aria-live="polite"
    >
      <div
        className="rounded-xl border border-indigo-300/45 bg-gradient-to-br from-indigo-500/15 via-indigo-500/10 to-transparent px-4 py-3 flex items-center gap-3 shadow-[0_0_18px_rgba(99,102,241,0.30)]"
        style={{ perspective: 1000 }}
      >
        <span className="text-[10px] sm:text-xs uppercase tracking-[0.25em] text-indigo-200/85 font-extrabold">
          {t("blackjackPvp.peekOverlayLabel", "Next card")}
        </span>
        <motion.div
          initial={{ rotateY: 180, opacity: 0 }}
          animate={{ rotateY: 0, opacity: 1 }}
          exit={{ rotateY: -180, opacity: 0 }}
          transition={{ duration: 0.55, type: "spring", stiffness: 110, damping: 16 }}
        >
          <CardFace card={card} small fade={false} />
        </motion.div>
      </div>
    </motion.div>
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
  myNameColor,
  oppNameColor,
  incomingEmote,
  myEmote,
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
  myNameColor?: string | null;
  oppNameColor?: string | null;
  incomingEmote?: { value: string } | null;
  myEmote?: { value: string } | null;
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
          <div className="relative mt-1">
            <AnimatePresence>
              {myEmote && (
                <motion.span
                  initial={{ opacity: 0, scale: 0.5 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.5 }}
                  transition={{ type: "spring", stiffness: 400, damping: 20 }}
                  className="absolute bottom-full left-0 mb-1 whitespace-nowrap rounded-xl rounded-br-sm border border-cyan-300/60 bg-[#071531] px-2 py-1 text-base normal-case tracking-normal shadow-[0_0_18px_rgba(0,229,255,.3)]"
                >
                  <EmoteArtwork emote={myEmote} imageClassName="h-7 w-7" />
                </motion.span>
              )}
            </AnimatePresence>
            <span
              className="block max-w-[110px] truncate text-[10px] uppercase tracking-widest text-white/50"
              style={myNameColor ? { color: myNameColor } : undefined}
            >
              {mySeatLabel}
            </span>
          </div>
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
          <div className="relative mt-1">
            <AnimatePresence>
              {incomingEmote && (
                <motion.span
                  initial={{ opacity: 0, scale: 0.5 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.5 }}
                  transition={{ type: "spring", stiffness: 400, damping: 20 }}
                  className="absolute bottom-full right-0 mb-1 whitespace-nowrap rounded-xl rounded-bl-sm border border-fuchsia-300/60 bg-[#071531] px-2 py-1 text-base normal-case tracking-normal shadow-[0_0_18px_rgba(255,60,172,.35)]"
                >
                  <EmoteArtwork emote={incomingEmote} imageClassName="h-7 w-7" />
                </motion.span>
              )}
            </AnimatePresence>
            <span
              className="block max-w-[110px] truncate text-[10px] uppercase tracking-widest text-white/50"
              style={oppNameColor ? { color: oppNameColor } : undefined}
            >
              {oppSeatLabel}
            </span>
          </div>
        </div>
      </div>

      {/* Round tracker — blue = rounds you won, red = rounds the
          opponent won (shared best-of marker, brawl-stars style). */}
      <div className="mt-3 flex justify-center border-t border-[#FFD700]/15 pt-3">
        <RoundMarkers
          total={totalRounds}
          myWins={myRounds}
          oppWins={oppRounds}
          myLabel={mySeatLabel}
          oppLabel={oppSeatLabel}
          compact
        />
      </div>
    </motion.div>
  );
}

function RoundResultModal({
  t,
  round,
  viewerIsPlayer1,
  mySeatLabel,
  oppSeatLabel,
  isAi,
  roundsWonPlayer1,
  roundsWonPlayer2,
  onDismiss,
}: {
  t: TFn;
  round: RoundRow;
  viewerIsPlayer1: boolean;
  mySeatLabel: string;
  oppSeatLabel: string;
  isAi: boolean;
  // Match-level round-win counters AFTER this round has been
  // resolved (the server increments these in the same transaction
  // as the round-row insert, so they always reflect the post-round
  // best-of-3 tally).
  roundsWonPlayer1: number;
  roundsWonPlayer2: number;
  onDismiss: () => void;
}) {
  // ── Resolution outcome ────────────────────────────────────────
  // `round.roundWinner` is server-truthy 'player1' | 'player2' |
  // 'draw'. The corresponding seat label resolves to either the
  // viewer (when viewerIsPlayer1 matches the winner) or the
  // opponent (when it doesn't).
  const isDraw = round.roundWinner === "draw";
  const player1Won = round.roundWinner === "player1";
  const viewerWon =
    (player1Won && viewerIsPlayer1) ||
    (round.roundWinner === "player2" && !viewerIsPlayer1);

  // Best-of-3 match perspective: 0..2 for each seat, with the
  // deciding seat at 2 if this round clinched the match.
  const myRounds = viewerIsPlayer1 ? roundsWonPlayer1 : roundsWonPlayer2;
  const oppRounds = viewerIsPlayer1 ? roundsWonPlayer2 : roundsWonPlayer1;

  const player1Label = t("blackjackPvp.seat.player1", "Joueur 1");
  const player2Label = isAi
    ? t("blackjackPvp.seat.ai", "GRYND AI")
    : t("blackjackPvp.seat.player2", "Joueur 2");
  const winnerSeatLabel = !isDraw
    ? player1Won
      ? player1Label
      : player2Label
    : "";

  const headerEmoji = isDraw ? <IconHeartHandshake size={56} className="text-yellow-300" /> : viewerWon ? <IconTrophy size={56} className="text-amber-400" /> : <IconSkull size={56} className="text-red-400" />;
  const headerPrimary = isDraw
    ? t("blackjackPvp.roundResult.drawTitle", "Manche nulle")
    : viewerWon
    ? t(
        "blackjackPvp.roundResult.winTitle",
        "{winner} remporte la manche {n}",
      )
        .replace("{winner}", winnerSeatLabel)
        .replace("{n}", String(round.roundNumber))
    : t(
        "blackjackPvp.roundResult.loseTitle",
        "{winner} remporte la manche {n}",
      )
        .replace("{winner}", winnerSeatLabel)
        .replace("{n}", String(round.roundNumber));
  const headerSecondary = isDraw
    ? t(
        "blackjackPvp.roundResult.drawSubtitle",
        "Aucune manche gagnée. Score identique",
      )
    : t(
        "blackjackPvp.roundResult.scoreLine",
        "Score: {me} {mine} – {theirs} {them}",
      )
        .replace("{me}", mySeatLabel)
        .replace("{mine}", String(myRounds))
        .replace("{theirs}", oppSeatLabel)
        .replace("{them}", String(oppRounds));

  // Round-end reveal values from the server snapshot. Both hands +
  // both scores + both end-states are visible from the moment the
  // round resolves — the closest-to-21-without-bust rule is already
  // applied server-side (decideRoundWinner).
  const p1Hand = round.player1Hand;
  const p2Hand = round.player2Hand;
  const p1Score = round.player1Score;
  const p2Score = round.player2Score;
  const p1Busted = round.player1State === "busted";
  const p2Busted = round.player2State === "busted";

  // Re-orient so the viewer always sees their own cards on the LEFT
  // seat (mirrors the live table layout).
  const myCards = viewerIsPlayer1 ? p1Hand : p2Hand;
  const oppCards = viewerIsPlayer1 ? p2Hand : p1Hand;
  const myFinalScore = viewerIsPlayer1 ? p1Score : p2Score;
  const oppFinalScore = viewerIsPlayer1 ? p2Score : p1Score;
  const myBusted = viewerIsPlayer1 ? p1Busted : p2Busted;
  const oppBusted = viewerIsPlayer1 ? p2Busted : p1Busted;
  const iWonSeat = !isDraw && viewerWon;
  const oppWonSeat = !isDraw && !viewerWon;
  const oppSubLabel = viewerIsPlayer1 ? oppSeatLabel : player1Label;

  // ── 5-second auto-dismiss ────────────────────────────────────
  // One-shot timer + ticking countdown so the popup stays visible
  // for exactly 5 seconds total, then dismisses. The visible
  // countdown (5 → 0) lives on `secondsLeft` and is what the
  // Continue button's "(Ns)" label reads from — so the user sees
  // the timer actively counting down, not a static "5s" string.
  // The user can still click anywhere to dismiss early.
  //
  // BUG-FIX (timer reset on every poll): the caller passes
  // `onDismiss={() => setRoundResultShownFor(null)}` — an inline
  // arrow that gets a new reference on EVERY parent re-render
  // (every 1.5s status poll). Including it in the useEffect deps
  // would cause the effect to re-run on every poll, cancelling
  // and re-scheduling the setTimeout, so the modal would never
  // auto-dismiss. We bridge via a ref so the timer is set ONCE
  // on mount and always invokes the latest callback.
  const onDismissRef = useRef(onDismiss);
  // 5 → 4 → 3 → 2 → 1 → 0 ticking state for the Continue-button
  // hint. Decoupled from the auto-dismiss timeout via refs so a
  // parent re-render can't reset the countdown (same React-rules-
  // of-hooks trick as the timer above).
  const [secondsLeft, setSecondsLeft] = useState(5);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const id = setTimeout(() => {
      onDismissRef.current?.();
    }, 5000);
    return () => clearTimeout(id);
    // Mount-only: key=round.id at the call site resets the timer
    // for each new round, NOT prop changes within the same round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [secondsLeft]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 px-4 backdrop-blur-sm"
      onClick={onDismiss}
    >
      <motion.div
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        transition={{ type: "spring", stiffness: 280, damping: 22 }}
        onClick={(e) => e.stopPropagation()}
        className={`relative w-full max-w-lg rounded-3xl border-4 p-5 sm:p-7 text-center shadow-2xl transition-colors duration-500 ${
          isDraw
            ? "border-yellow-400 bg-gradient-to-b from-[#3a3a1a] to-[#1a1a0d] shadow-[0_0_40px_rgba(250,204,21,0.30)]"
            : iWonSeat
            ? "border-amber-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_50px_rgba(251,191,36,0.35)]"
            : "border-red-500 bg-gradient-to-b from-[#3a1a1a] to-[#2b0d0d] shadow-[0_0_40px_rgba(239,68,68,0.25)]"
        }`}
      >
        {/* ── Header — emoji + winner seat name + score line. */}
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          <div className="text-4xl sm:text-5xl mb-1 drop-shadow">
            {headerEmoji}
          </div>
          <h2
            className={`text-xl sm:text-2xl font-black leading-tight ${
              isDraw
                ? "text-yellow-200"
                : iWonSeat
                ? "text-amber-300"
                : "text-red-300"
            }`}
          >
            {headerPrimary}
          </h2>
          <p className="mt-1.5 text-sm font-bold text-white/85">
            {headerSecondary}
          </p>
        </motion.div>

        {/* ── Both seats — cards fully revealed + scores visible.
            Side-by-side grid; the winning seat gets the gold border
            + glow so the contrast reads at a glance. */}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <RoundResultSeat
            label={mySeatLabel}
            subLabel={t("blackjackPvp.you", "vous")}
            hand={myCards}
            score={myFinalScore}
            busted={myBusted}
            didWin={iWonSeat}
            highlight="self"
            t={t}
          />
          <RoundResultSeat
            label={oppSeatLabel}
            subLabel={oppSubLabel}
            hand={oppCards}
            score={oppFinalScore}
            busted={oppBusted}
            didWin={oppWonSeat}
            highlight="opp"
            t={t}
          />
        </div>

        {/* ── Resolution rule reminder — quickest "closest-to-21
            without busting" reference so the player understands the
            outcome. Stays tiny so it doesn't fight the header. */}
        <p className="mt-4 text-[10px] sm:text-xs text-white/55 leading-relaxed">
          {t(
            "blackjackPvp.roundResult.rule",
            "Le score le plus proche de 21 sans dépasser gagne; au‑delà de 21 = sauté.",
          )}
        </p>

        {/* ── Footer button — dismiss immediately. The auto-dismiss
            timer above provides the 5‑second timeout; this button is
            for impatient players. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className={`mt-4 inline-flex items-center justify-center gap-2 rounded-xl border-b-4 px-6 py-2.5 text-base font-black transition active:translate-y-[2px] ${
            isDraw
              ? "border-yellow-700 bg-yellow-400 text-black hover:bg-yellow-300"
              : iWonSeat
              ? "border-amber-700 bg-amber-400 text-black hover:bg-amber-300"
              : "border-cyan-700 bg-cyan-400 text-black hover:bg-cyan-300"
          }`}
        >
          {t("blackjackPvp.continue", "Continuer")}
          <span className="text-xs opacity-70 tabular-nums" aria-live="polite">
            ({secondsLeft}s)
          </span>
        </button>
      </motion.div>
    </motion.div>
  );
}

// Inline per-seat rendering for the round-end popup. Cards are
// always face-up here (no animation gating), so the seat stays a
// thin presentational component — no phase state required.
function RoundResultSeat({
  label,
  subLabel,
  hand,
  score,
  busted,
  didWin,
  highlight,
  t,
}: {
  label: string;
  subLabel: string;
  hand: Card[];
  score: number;
  busted: boolean;
  didWin: boolean;
  highlight: "self" | "opp";
  t: TFn;
}) {
  // The winning seat wears the gold border + glow + crown; the
  // losing seat dims slightly so the contrast reads at a glance.
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
      className={`relative rounded-2xl border-2 p-2 flex flex-col items-center gap-2 transition-colors duration-500 ${seatBorder} ${seatBg} ${seatGlow} ${
        didWin ? "" : busted ? "" : "opacity-85"
      }`}
    >
      <AnimatePresence>
        {didWin && (
          <motion.div
            key="crown-badge"
            initial={{ scale: 0, rotate: -30, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 14 }}
            className="absolute -top-3 -right-2 text-2xl drop-shadow-md pointer-events-none"
            aria-hidden
          >
            <IconCrown size={24} className="text-yellow-400" />
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={`flex flex-col items-center gap-0.5 text-[10px] sm:text-xs font-bold leading-tight ${
          didWin ? "text-amber-200" : "text-white/85"
        }`}
      >
        <span>
          {highlight === "self" ? <span className="inline-flex items-center gap-0.5"><IconStarFilled size={10} className="text-yellow-400" /> {label}</span> : label}
        </span>
        <span className="text-[9px] uppercase tracking-wider text-white/55">
          {subLabel}
        </span>
      </div>

      <div className="flex justify-center gap-1.5 flex-wrap min-h-[96px]">
        {hand.length === 0 ? (
          <BlackjackCardBack />
        ) : (
          hand.map((c, i) => (
            <motion.div
              key={i}
              initial={{ rotateY: 90, opacity: 0, y: -10 }}
              animate={{ rotateY: 0, opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.05 + i * 0.07 }}
            >
              <CardFace card={c} small />
            </motion.div>
          ))
        )}
      </div>

      <div className="text-sm font-black">
        {busted ? (
          <span className="text-red-300">
            {t("blackjackPvp.bustedScore", "Sauté ({score})").replace(
              "{score}",
              String(score),
            )}
          </span>
        ) : (
          <span className={didWin ? "text-amber-300" : "text-white/80"}>
            {score} {t("blackjackPvp.ptsUnit", "pts")}
          </span>
        )}
      </div>
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
        <div className="mb-2 flex justify-center"><IconX size={64} className="text-red-400" /></div>
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

// ── Resign confirmation modal ────────────────────────────────────────
// Guards the stake-forfeiting resign action: the player confirms the
// amount they're giving up before the resign API is hit.
function ResignConfirmModal({
  t,
  stake,
  busy,
  onCancel,
  onConfirm,
}: {
  t: TFn;
  stake: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.85, y: 30 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.85, y: 30 }}
        transition={{ type: "spring", stiffness: 300, damping: 18 }}
        className="relative w-full max-w-md rounded-3xl border-4 border-red-500/60 bg-gradient-to-b from-[#3a1a1a] to-[#2b0d0d] p-6 text-center shadow-2xl"
      >
        <div className="mb-2 flex justify-center"><IconFlag size={64} className="text-red-400" /></div>
        <h2 className="mt-2 text-3xl font-black uppercase text-red-400">
          {t("blackjackPvp.resign.title", "Abandonner la partie ?")}
        </h2>
        <p className="mt-3 text-white/80 text-sm">
          {t(
            "blackjackPvp.resign.body",
            "Vous perdrez votre mise de {amount}. Votre adversaire remporte la partie.",
          ).replace(
            "{amount}",
            Number(stake || 0).toLocaleString(),
          )}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-xl border-b-4 border-white/20 bg-white/10 px-6 py-2.5 text-sm font-bold text-white transition active:translate-y-[2px] disabled:opacity-40"
          >
            {t("blackjackPvp.resign.cancel", "Continuer à jouer")}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="rounded-xl border-b-4 border-red-700 bg-red-500 px-6 py-2.5 text-sm font-black text-white transition active:translate-y-[2px] disabled:opacity-40"
          >
            {busy
              ? t("blackjackPvp.resign.loading", "Abandon en cours…")
              : t("blackjackPvp.resign.confirm", "Abandonner")}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Leave (vs-AI) confirmation modal ────────────────────────────────
// Free vs-AI matches have no stake, so leaving is a plain exit back to
// the lobby — no resign API call, no forfeiture copy.
function LeaveAiConfirmModal({
  t,
  onCancel,
  onConfirm,
}: {
  t: TFn;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.85, y: 30 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.85, y: 30 }}
        transition={{ type: "spring", stiffness: 300, damping: 18 }}
        className="relative w-full max-w-md rounded-3xl border-4 border-[#00e5ff]/40 bg-gradient-to-b from-[#0a1533] to-[#040d24] p-6 text-center shadow-2xl"
      >
        <div className="mb-2 flex justify-center text-6xl" aria-hidden>🚪</div>
        <h2 className="mt-2 text-3xl font-black uppercase text-[#00e5ff]">
          {t("blackjackPvp.leave.title", "Leave this match?")}
        </h2>
        <p className="mt-3 text-white/80 text-sm">
          {t(
            "blackjackPvp.leave.body",
            "This is a free practice match — nothing is at stake. Leave and play again any time.",
          )}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={onCancel}
            className="rounded-xl border-b-4 border-white/20 bg-white/10 px-6 py-2.5 text-sm font-bold text-white transition active:translate-y-[2px]"
          >
            {t("blackjackPvp.resign.cancel", "Keep playing")}
          </button>
          <button
            onClick={onConfirm}
            className="rounded-xl border-b-4 border-cyan-700 bg-cyan-400 px-6 py-2.5 text-sm font-black text-black transition active:translate-y-[2px]"
          >
            {t("blackjackPvp.leave.confirm", "Leave match")}
          </button>
        </div>
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
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
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
      <div className="mb-2 flex justify-center"><IconPlayerSkipForward size={28} className="text-[#FFD700]" /></div>
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
