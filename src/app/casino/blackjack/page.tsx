"use client";
import React, { useState, useEffect, useRef, useCallback } from "react";
import { useUser } from "@clerk/nextjs";
import BlackjackCardBack from "../../../components/BlackjackCardBack";
import { useRouter } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import NavigationBar from "../../../components/navigation-bar";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";
import { playCardDraw, playVictory, playDefeat } from "../../../lib/gameAudio";
import { CHIP_VALUES } from "../../../lib/rouletteConfig";

// ─── Card types & helpers ───────────────────────────────────────
type Card = { suit: string; value: string };
type GameResult = "win" | "lose" | "push" | "bust";

const isRedSuit = (suit: string) => suit === "♥" || suit === "♦";

const calcHandValue = (cards: Card[]) => {
  let value = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.value === "A") { aces++; value += 11; }
    else if (["K", "Q", "J"].includes(c.value)) value += 10;
    else value += parseInt(c.value);
  }
  while (value > 21 && aces > 0) { value -= 10; aces--; }
  return value;
};

// ─── Card face component ────────────────────────────────────────
const CardFace: React.FC<{ card: Card; small?: boolean }> = ({ card, small }) => {
  const red = isRedSuit(card.suit);
  const size = small ? "h-24 w-16 text-base" : "h-28 w-20 text-xl";
  const pipSize = small ? "text-xs" : "text-sm";
  return (
    <div className={`${size} bg-gradient-to-br from-white to-gray-100 rounded-lg shadow-lg border border-gray-300 flex flex-col justify-between p-1.5 select-none relative overflow-hidden`}>
      {/* Top-left pip */}
      <div className={`flex flex-col items-start leading-tight ${pipSize} font-bold`} style={{ color: red ? "#c0392b" : "#1a1a2e" }}>
        <span>{card.value}</span>
        <span className={small ? "text-[10px]" : "text-xs"}>{card.suit}</span>
      </div>
      {/* Center suit */}
      <div className="absolute inset-0 flex items-center justify-center opacity-20 pointer-events-none" style={{ color: red ? "#c0392b" : "#1a1a2e" }}>
        <span className={small ? "text-4xl" : "text-5xl"}>{card.suit}</span>
      </div>
      {/* Bottom-right pip (inverted) */}
      <div className={`flex flex-col items-end leading-tight ${pipSize} font-bold rotate-180`} style={{ color: red ? "#c0392b" : "#1a1a2e" }}>
        <span>{card.value}</span>
        <span className={small ? "text-[10px]" : "text-xs"}>{card.suit}</span>
      </div>
    </div>
  );
};

// ─── Main page ──────────────────────────────────────────────────
export default function BlackjackPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();
  const posthog = usePostHog();

  const [userTokens, setUserTokens] = useState<number | null>(null);
  const [gameState, setGameState] = useState<"idle" | "dealing" | "playing" | "finished">("idle");
  const [bet, setBet] = useState(10);
  const [dealerCards, setDealerCards] = useState<Card[]>([]);
  const [playerCards, setPlayerCards] = useState<Card[]>([]);
  const [remainingDeck, setRemainingDeck] = useState<Card[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [canDouble, setCanDouble] = useState(false);
  const [canSplit, setCanSplit] = useState(false);
  const [isSplit, setIsSplit] = useState(false);
  const [hands, setHands] = useState<Card[][]>([]);
  const [activeHandIndex, setActiveHandIndex] = useState(0);
  const [showRules, setShowRules] = useState(false);
  const [showResultModal, setShowResultModal] = useState(false);
  const [resultType, setResultType] = useState<GameResult>("lose");
  const [resultMsg, setResultMsg] = useState("");
  const [stats, setStats] = useState({ wins: 0, losses: 0, pushes: 0, played: 0 });
  const [dealerRevealed, setDealerRevealed] = useState(false);
  const resultCelebratedRef = useRef(false);

  const handsRef = useRef<Card[][]>([]);
  const splitBustsRef = useRef<boolean[]>([false, false]);
  const splitBetRef = useRef<number>(10);
  const playerCardsRef = useRef<Card[]>([]);

  useEffect(() => { playerCardsRef.current = playerCards; }, [playerCards]);

  // ─── Fetch balance ────────────────────────────────────────────
  const fetchTokens = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch("/api/get-user-tokens", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } });
      const data = await res.json();
      if (data.success) setUserTokens(data.data.balance);
    } catch { /* silent */ }
  }, [user]);

  useEffect(() => { if (isSignedIn && user) fetchTokens(); }, [isSignedIn, user, fetchTokens]);

  // ─── Deduct extra bet (for double/split) ──────────────────────
  const deductExtraBet = async (amount: number): Promise<boolean> => {
    try {
      const res = await fetch("/api/blackjack/place-bet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      const data = await res.json();
      if (data.success) { setUserTokens(data.data.newBalance); return true; }
      setError("Solde insuffisant pour cette action");
      return false;
    } catch { setError("Erreur lors du prélèvement"); return false; }
  };

  // ─── Settle game ──────────────────────────────────────────────
  const settleGame = useCallback(async (result: GameResult, bj: boolean, betAmt: number, payout: number) => {
    try {
      await fetch("/api/blackjack/update-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result, blackjack: bj ? 1 : 0, amount: betAmt, payout }),
      });
      await fetchTokens();
    } catch { setError("Erreur en fin de partie"); }
  }, [fetchTokens]);

  // ─── Start game ───────────────────────────────────────────────
  const startGame = async () => {
    if (!isSignedIn) return router.push("/sign-in?redirect_url=/casino/blackjack");
    if (userTokens! < bet) return setError("Solde insuffisant pour cette mise");
    setError(null);
    setGameState("dealing");
    setDealerRevealed(false);
    resultCelebratedRef.current = false;
    setIsSplit(false);
    setHands([]);

    try {
      // Deduct bet
      const placeRes = await fetch("/api/blackjack/place-bet", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: bet }),
      });
      const placeData = await placeRes.json();
      if (!placeData.success) { setError(placeData.error || "Erreur lors de la mise"); setGameState("idle"); return; }
      const newBal = Number(placeData.data.newBalance);
      setUserTokens(newBal);

      // Get server-side shuffled deck
      const dealRes = await fetch("/api/blackjack/deal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const dealData = await dealRes.json();
      if (!dealData.success) { setError("Erreur lors de la distribution"); setGameState("idle"); return; }

      const pCards: Card[] = dealData.data.playerCards;
      const dCards: Card[] = dealData.data.dealerCards;
      const deck: Card[] = dealData.data.remainingDeck;

      setPlayerCards(pCards);
      setDealerCards(dCards);
      setRemainingDeck(deck);
      setMessage("");
      setGameState("playing");

      const sameVal = pCards[0].value === pCards[1].value;
      setCanDouble(newBal >= bet * 2);
      setCanSplit(sameVal && newBal >= bet * 2);

      playCardDraw(); // initial deal sound
      posthog?.capture("blackjack_game_started", { bet_amount: bet });
      if (calcHandValue(pCards) === 21) {
        setDealerRevealed(true);
        endGame("win", bet);
      }
    } catch { setError("Erreur au démarrage"); setGameState("idle"); }
  };

  // ─── Hit ──────────────────────────────────────────────────────
  const hit = async () => {
    if (remainingDeck.length === 0) return;
    playCardDraw();
    const card = remainingDeck[0];
    const newDeck = remainingDeck.slice(1);
    setRemainingDeck(newDeck);
    const newHand = [...playerCards, card];
    setPlayerCards(newHand);
    // Keep handsRef in sync during split
    if (isSplit) {
      const updated = [...handsRef.current];
      updated[activeHandIndex] = newHand;
      handsRef.current = updated;
    }
    const val = calcHandValue(newHand);
    if (val > 21) {
      if (isSplit) {
        // Record bust and move to next hand
        splitBustsRef.current[activeHandIndex] = true;
        setTimeout(() => finishCurrentHand(), 400);
      } else {
        endGame("bust", bet);
      }
    } else if (val === 21) {
      if (isSplit) setTimeout(() => finishCurrentHand(), 400);
      else setTimeout(() => stand(), 600);
    }
  };

  // ─── Stand ─────────────────────────────────────────────────────
  const stand = () => {
    setDealerRevealed(true);
    let currentDealer = [...dealerCards];
    let currentDeck = [...remainingDeck];
    // Dealer draws
    while (calcHandValue(currentDealer) < 17 && currentDeck.length > 0) {
      playCardDraw();
      currentDealer = [...currentDealer, currentDeck[0]];
      currentDeck = currentDeck.slice(1);
    }
    setDealerCards(currentDealer);
    setRemainingDeck(currentDeck);

    const pVal = calcHandValue(playerCards);
    const dVal = calcHandValue(currentDealer);
    setTimeout(() => {
      if (dVal > 21 || pVal > dVal) endGame("win", bet);
      else if (dVal > pVal) endGame("lose", bet);
      else endGame("push", bet);
    }, 600);
  };

  // ─── Double Down ──────────────────────────────────────────────
  const doubleDown = async () => {
    // Deduct extra bet
    const ok = await deductExtraBet(bet);
    if (!ok) return;
    setCanDouble(false);
    const newBet = bet * 2;
    setBet(newBet);
    playCardDraw();
    const card = remainingDeck[0];
    const newDeck = remainingDeck.slice(1);
    setRemainingDeck(newDeck);
    const newHand = [...playerCards, card];
    setPlayerCards(newHand);
    if (calcHandValue(newHand) > 21) { endGame("bust", newBet); }
    else { setTimeout(() => { setBet(newBet); stand(); }, 50); }
  };

  // ─── Split ────────────────────────────────────────────────────
  const splitHand = async () => {
    if (playerCards.length !== 2) return;
    const ok = await deductExtraBet(bet);
    if (!ok) return;
    const [first, second] = playerCards;
    const deck = [...remainingDeck];
    const newHands = [[first, deck[0]], [second, deck[1]]];
    const newDeck = deck.slice(2);
    handsRef.current = newHands;
    splitBustsRef.current = [false, false];
    splitBetRef.current = bet;
    setHands(newHands);
    setRemainingDeck(newDeck);
    setActiveHandIndex(0);
    setIsSplit(true);
    setPlayerCards(newHands[0]);
    setCanSplit(false);
  };

  const finishCurrentHand = () => {
    // Save current hand's cards from latest ref (avoids stale closure)
    const updated = [...handsRef.current];
    updated[activeHandIndex] = [...playerCardsRef.current];
    handsRef.current = updated;
    setHands(updated);

    if (activeHandIndex === 0 && handsRef.current[1]) {
      // Switch to hand 1
      setActiveHandIndex(1);
      setPlayerCards(handsRef.current[1]);
    } else {
      // Both hands done — resolve split
      resolveSplit();
    }
  };

  const nextSplitHand = () => {
    finishCurrentHand();
  };

  // ─── Resolve split hands against dealer ──────────────────────
  const resolveSplit = async () => {
    setDealerRevealed(true);
    // Play dealer once
    let currentDealer = [...dealerCards];
    let currentDeck = [...remainingDeck];
    while (calcHandValue(currentDealer) < 17 && currentDeck.length > 0) {
      playCardDraw();
      currentDealer = [...currentDealer, currentDeck[0]];
      currentDeck = currentDeck.slice(1);
    }
    setDealerCards(currentDealer);
    setRemainingDeck(currentDeck);

    const dVal = calcHandValue(currentDealer);
    const handBets = splitBetRef.current;
    const handCards = handsRef.current;
    const busts = splitBustsRef.current;

    // Settle each hand independently
    const results: { result: GameResult; msg: string }[] = [];
    let totalPayout = 0;

    for (let h = 0; h < 2; h++) {
      let result: GameResult;
      let payout = 0;

      if (busts[h]) {
        result = "bust";
      } else {
        const pVal = calcHandValue(handCards[h]);
        if (dVal > 21 || pVal > dVal) {
          result = "win";
          payout = handBets * 2;
        } else if (dVal === pVal) {
          result = "push";
          payout = handBets;
        } else {
          result = "lose";
        }
      }

      results.push({
        result,
        msg: result === "win" ? `Main ${h + 1} : Gagné (+${payout - handBets})`
          : result === "push" ? `Main ${h + 1} : Égalité`
          : `Main ${h + 1} : Perdu`,
      });
      totalPayout += payout;

      // Settle each hand (await for proper error handling)
      await settleGame(result, false, handBets, payout);
    }

    const msg = results.map(r => r.msg).join(" | ");
    setMessage(msg);
    setGameState("finished");
    setIsSplit(false);
    setHands([]);

    const winCount = results.filter(r => r.result === "win").length;
    const pushCount = results.filter(r => r.result === "push").length;
    const lossCount = 2 - winCount - pushCount;      const outcome: GameResult = winCount > lossCount ? "win" : lossCount > winCount ? "lose" : "push";
    setResultType(outcome);
    setResultMsg(msg);
    setShowResultModal(true);
    posthog?.capture("blackjack_game_ended", { result: outcome, bet_amount: splitBetRef.current, split: true });

    setStats(prev => ({
      wins: prev.wins + winCount,
      losses: prev.losses + lossCount,
      pushes: prev.pushes + pushCount,
      played: prev.played + 1,
    }));

    if (outcome === "win") {
      playVictory();
      if (!resultCelebratedRef.current) {
        resultCelebratedRef.current = true;
        confetti({ particleCount: 60, spread: 70, origin: { y: 0.6 }, colors: ["#FFD700", "#FFA500", "#FFFFFF"] });
        setTimeout(() => confetti({ particleCount: 30, spread: 50, origin: { y: 0.5 }, colors: ["#FFD700", "#FFFFFF"] }), 300);
      }
    } else {
      playDefeat();
    }
  };

  // ─── End game ────────────────────────────────────────────────────────────────────
  const endGame = useCallback(async (result: GameResult, betAmt: number) => {
    const blackjack = playerCards.length === 2 && calcHandValue(playerCards) === 21;
    let winAmount = 0;
    let msg = "";

    if (result === "win") {
      winAmount = blackjack ? betAmt * 2.5 : betAmt * 2;
      msg = blackjack ? "Blackjack !" : "Vous avez gagné !";
    } else if (result === "push") {
      winAmount = betAmt;
      msg = "Égalité !";
    } else {
      msg = result === "bust" ? "Vous avez dépassé 21 !" : "Vous avez perdu !";
    }

    await settleGame(result, blackjack, betAmt, winAmount);
    setMessage(msg);
      setGameState("finished");
      setIsSplit(false);
      setHands([]);

      const outcome: GameResult = result === "win" ? "win" : result === "push" ? "push" : "lose";
      setResultType(outcome);
      setResultMsg(msg);
      setShowResultModal(true);
      posthog?.capture("blackjack_game_ended", { result: outcome, bet_amount: betAmt, blackjack });
      setStats(prev => ({
        wins: outcome === "win" ? prev.wins + 1 : prev.wins,
        losses: outcome === "lose" ? prev.losses + 1 : prev.losses,
        pushes: outcome === "push" ? prev.pushes + 1 : prev.pushes,
        played: prev.played + 1,
      }));
      if (outcome === "win") {
        playVictory();
        if (!resultCelebratedRef.current) {
          resultCelebratedRef.current = true;
          confetti({ particleCount: 60, spread: 70, origin: { y: 0.6 }, colors: ["#FFD700", "#FFA500", "#FFFFFF"] });
          setTimeout(() => confetti({ particleCount: 30, spread: 50, origin: { y: 0.5 }, colors: ["#FFD700", "#FFFFFF"] }), 300);
        }
      } else {
        playDefeat();
      }
  }, [playerCards, settleGame]);

  // ─── New game ──────────────────────────────────────────────────
  const newGame = () => {
    setGameState("idle");
    setBet(10);
    setPlayerCards([]);
    setDealerCards([]);
    setRemainingDeck([]);
    setMessage("");
    setDealerRevealed(false);
    setShowResultModal(false);
    resultCelebratedRef.current = false;
    handsRef.current = [];
    splitBustsRef.current = [false, false];
    splitBetRef.current = 10;
    playerCardsRef.current = [];
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] pb-24 pt-20 text-white md:pb-8">
      <NavigationBar currentPath="/casino" />

      {/* Result Modal */}
      <AnimatePresence>
        {showResultModal && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.8, y: 40 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.8, y: 40 }}
              transition={{ type: "spring", stiffness: 300, damping: 15 }}
              className={`relative w-full max-w-md rounded-3xl border-4 p-6 text-center shadow-2xl ${
                resultType === "win" ? "border-amber-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_50px_rgba(251,191,36,0.3)]"
                : resultType === "push" ? "border-yellow-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_40px_rgba(250,204,21,0.2)]"
                : "border-red-500 bg-gradient-to-b from-[#3a1a1a] to-[#2b0d0d] shadow-[0_0_40px_rgba(239,68,68,0.2)]"
              }`}
            >
              <motion.div initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={{ delay: 0.2 }} className="mb-2 text-7xl">
                {resultType === "win" ? "🏆" : resultType === "push" ? "🤝" : "💀"}
              </motion.div>
              <h2 className={`mt-2 text-3xl font-black uppercase ${resultType === "win" ? "text-amber-300" : resultType === "push" ? "text-yellow-300" : "text-red-400"}`}>
                {resultType === "win" ? "Gagné !" : resultType === "push" ? "Égalité" : "Perdu"}
              </h2>
              <p className="mt-2 text-white/80">{resultMsg}</p>
              <button onClick={newGame} className={`mt-6 rounded-xl border-b-4 px-8 py-3 text-lg font-black transition active:translate-y-[2px] ${resultType === "win" ? "border-amber-700 bg-amber-400 text-black" : "border-cyan-700 bg-cyan-400 text-black"}`}>
                Rejouer
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mx-auto max-w-5xl px-3 py-4 sm:px-4 sm:py-6">
        {/* Header */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl sm:text-3xl font-bold text-[#FFD700] drop-shadow-[0_0_10px_rgba(255,215,0,0.4)]">🃏 Blackjack</h1>
          {userTokens !== null && (
            <span className="px-4 py-1.5 bg-[#FFD700]/15 border border-[#FFD700]/40 text-[#fffec7] rounded-full font-extrabold text-sm shadow-[0_0_10px_rgba(255,215,0,0.3)]">
              Jetons : {userTokens.toLocaleString()}
            </span>
          )}
        </div>

        {error && <div className="mb-3 bg-red-500/10 border border-red-500/30 text-red-400 p-2 rounded text-sm text-center">{error}</div>}

        {/* Game table */}
        <div className="rounded-2xl border border-[#FFD700]/25 bg-gradient-to-br from-[#001933]/90 via-[#00111f]/90 to-[#000814]/90 shadow-[0_0_30px_rgba(255,215,0,0.12)] p-4 sm:p-6">
          {/* Dealer */}
          <div className="text-center mb-2">
            <h2 className="text-[#FFD700]/80 text-sm font-semibold">Croupier</h2>
            {dealerCards.length > 0 && <p className="text-[#FFD700]/60 text-xs mt-0.5">{dealerRevealed ? `${calcHandValue(dealerCards)} pts` : `? + ${dealerCards[1] ? calcHandValue([dealerCards[1]]) : "?"}`}</p>}
          </div>
          <div className="flex justify-center gap-3 mb-5 flex-wrap">
            {gameState === "idle" ? (
              [0, 1].map(i => (
                <BlackjackCardBack key={i} />
              ))
            ) : (
              dealerCards.map((card, i) => (
                <motion.div
                  key={i}
                  initial={{ y: -40, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.35, delay: i * 0.12 }}
                >
                  {!dealerRevealed && i === 0 ? (
                    <motion.div
                      animate={dealerRevealed ? { rotateY: 0 } : {}}
                    >
                      <BlackjackCardBack />
                    </motion.div>
                  ) : (
                    <motion.div
                      initial={i === 0 && dealerRevealed ? { rotateY: 90 } : {}}
                      animate={{ rotateY: 0 }}
                      transition={{ duration: 0.4 }}
                    >
                      <CardFace card={card} />
                    </motion.div>
                  )}
                </motion.div>
              ))
            )}
          </div>

          <div className="my-3 h-px bg-[#FFD700]/20" />

          {/* Player */}
          <div className="text-center mb-2">
            <h2 className="text-[#FFD700]/80 text-sm font-semibold">Vos cartes</h2>
            {playerCards.length > 0 && <p className="text-[#FFD700]/60 text-xs mt-0.5">{calcHandValue(playerCards)} pts</p>}
          </div>
          <div className="flex justify-center gap-3 mb-4 flex-wrap">
            {gameState === "idle" ? (
              [0, 1].map(i => (
                <BlackjackCardBack key={i} />
              ))
            ) : (
              playerCards.map((card, i) => (
                <motion.div
                  key={i}
                  initial={{ y: 60, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.35, delay: i * 0.12 }}
                  className={calcHandValue(playerCards) > 21 ? "animate-shake" : ""}
                >
                  <CardFace card={card} />
                </motion.div>
              ))
            )}
          </div>

          {/* Result text */}
          {message && <div className={`text-center text-lg font-bold mb-3 ${resultType === "win" ? "text-amber-400" : resultType === "push" ? "text-yellow-400" : "text-red-400"}`}>{message}</div>}

          {/* Idle / Finished: bet controls */}
          {(gameState === "idle" || gameState === "finished") && (
            <div className="flex flex-col items-center gap-3">
              {/* Quick-select chips */}
              <div className="flex flex-wrap gap-1.5 justify-center">
                {CHIP_VALUES.map(val => (
                  <button
                    key={val}
                    onClick={() => setBet(val)}
                    className={`px-2.5 py-1 rounded-full text-xs font-bold border transition-all duration-150 ${
                      bet === val ? "bg-[#FFD700] text-black border-[#FFD700] shadow-[0_0_10px_rgba(255,215,0,0.5)] scale-110"
                      : "bg-[#0a1a3a] text-[#FFD700]/80 border-[#FFD700]/30 hover:bg-[#FFD700]/20"
                    }`}
                  >{val}</button>
                ))}
              </div>

              <div className="flex items-center gap-3">
                <label className="text-[#FFD700] text-sm font-semibold">Mise :</label>
                <input type="number" min={1} max={userTokens ?? 999999} value={bet}
                  onChange={e => { const v = Number(e.target.value); setBet(isNaN(v) ? 0 : Math.min(v, userTokens ?? v)); }}
                    onBlur={() => { if (!bet || bet < 1) setBet(1); }}
                  className="w-28 px-3 py-1.5 rounded-lg bg-[#00111f] text-[#d8fbff] border border-[#FFD700]/30 focus:outline-none focus:ring-2 focus:ring-[#FFD700]/40 text-center text-sm" />
                <button onClick={() => userTokens && setBet(Math.max(1, Math.floor(userTokens / 2)))} className="px-3 py-1.5 rounded-lg border border-[#FFD700]/30 bg-[#FFD700]/15 text-[#FFD700] text-xs font-bold hover:bg-[#FFD700]/25 transition">½</button>
                <button onClick={() => userTokens && setBet(userTokens)} className="px-3 py-1.5 rounded-lg border border-[#FFD700]/30 bg-[#FFD700]/15 text-[#FFD700] text-xs font-bold hover:bg-[#FFD700]/25 transition">TOUT</button>
              </div>

              <button onClick={startGame} className="px-8 py-3 rounded-full font-bold text-lg border border-[#FFD700]/40 bg-[#FFD700]/20 text-[#FFD700] hover:bg-[#FFD700]/35 active:scale-95 transition shadow-[0_0_18px_rgba(255,215,0,0.35)]">
                Miser
              </button>
            </div>
          )}

          {/* Playing: action buttons */}
          {gameState === "playing" && !isSplit && (
            <div className="flex justify-center gap-3 flex-wrap mt-4">
              <button onClick={hit} className="px-5 py-2 rounded-lg border border-[#FFD700]/30 bg-[#FFD700]/15 text-[#FFD700] font-semibold text-sm hover:bg-[#FFD700]/25 transition">Carte</button>
              <button onClick={stand} className="px-5 py-2 rounded-lg border border-[#00e5ff]/30 bg-[#00e5ff]/15 text-[#00e5ff] font-semibold text-sm hover:bg-[#00e5ff]/25 transition">Rester</button>
              {canDouble && <button onClick={doubleDown} className="px-5 py-2 rounded-lg border border-purple-400/30 bg-purple-400/15 text-purple-300 font-semibold text-sm hover:bg-purple-400/25 transition">Doubler</button>}
              {canSplit && <button onClick={splitHand} className="px-5 py-2 rounded-lg border border-pink-400/30 bg-pink-400/15 text-pink-300 font-semibold text-sm hover:bg-pink-400/25 transition">Séparer</button>}
            </div>
          )}
          {gameState === "playing" && isSplit && (
            <div className="flex justify-center gap-3 flex-wrap mt-4">
              <button onClick={hit} className="px-5 py-2 rounded-lg border border-[#FFD700]/30 bg-[#FFD700]/15 text-[#FFD700] font-semibold text-sm">Carte (Main {activeHandIndex + 1})</button>
              <button onClick={nextSplitHand} className="px-5 py-2 rounded-lg border border-[#00e5ff]/30 bg-[#00e5ff]/15 text-[#00e5ff] font-semibold text-sm">{activeHandIndex === 0 && hands[1] ? "Main suivante" : "Rester"}</button>
            </div>
          )}
        </div>

        {/* Rules + Stats */}
        <div className="mt-4 flex flex-col sm:flex-row gap-3">
          {/* Stats */}
          {stats.played > 0 && (
            <div className="flex-1 bg-[#001933]/60 border border-[#FFD700]/15 rounded-lg p-3 text-xs text-[#FFD700]/70 space-y-1">
              <h3 className="text-[#FFD700] font-bold text-sm mb-1">Statistiques</h3>
              <div className="flex justify-between"><span>Parties</span><span className="text-white font-bold">{stats.played}</span></div>
              <div className="flex justify-between"><span>Victoires</span><span className="text-green-400 font-bold">{stats.wins}</span></div>
              <div className="flex justify-between"><span>Défaites</span><span className="text-red-400 font-bold">{stats.losses}</span></div>
              <div className="flex justify-between"><span>Égalités</span><span className="text-yellow-400 font-bold">{stats.pushes}</span></div>
            </div>
          )}

          {/* Rules toggle */}
          <div className="flex-1">
            <button onClick={() => setShowRules(!showRules)} className="w-full px-4 py-2.5 rounded-lg border border-[#FFD700]/25 bg-[#FFD700]/10 text-[#FFD700] font-bold text-sm hover:bg-[#FFD700]/20 transition text-left">
              📖 {showRules ? "Masquer les règles ▲" : "Voir les règles ▼"}
            </button>
            {showRules && (
              <div className="mt-2 bg-[#020617] border border-[#FFD700]/20 rounded-xl p-4 text-white text-xs sm:text-sm max-h-52 overflow-y-auto leading-relaxed">
                <h3 className="text-[#FFD700] font-bold mb-2 text-center">Règles du Blackjack</h3>
                <div className="space-y-2">
                  <p><strong>🎯 Objectif :</strong> Battre le croupier en obtenant un total proche de 21 sans dépasser.</p>
                  <p><strong>🃏 Valeurs :</strong> 2-10 = valeur faciale · J/Q/K = 10 · As = 1 ou 11</p>
                  <p><strong>⚡ Actions :</strong> Carte (tirer), Rester (arrêter), Doubler (×2 mise + 1 carte), Séparer (paires en 2 mains)</p>
                  <p><strong>🏆 Paiements :</strong> Blackjack naturel = ×2.5 · Victoire standard = ×2 · Égalité = mise rendue</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Animations */}
      <style jsx>{`
        @keyframes shake {
          0%,100% { transform: translateX(0); }
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
