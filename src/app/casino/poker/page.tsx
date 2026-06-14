"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import confetti from "canvas-confetti";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import { playCardDraw, playVictory, playDefeat } from "../../../lib/gameAudio";

const CHIP_VALUES = [1, 5, 10, 25, 50, 100, 500];

const SUIT_SYMBOLS: Record<string, string> = {
  hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠",
};

const HAND_NAMES_FR: Record<string, string> = {
  "Royal Flush": "Quinte Flush Royale",
  "Straight Flush": "Quinte Flush",
  "Four of a Kind": "Carré",
  "Full House": "Full",
  "Flush": "Couleur",
  "Straight": "Quinte",
  "Three of a Kind": "Brelan",
  "Two Pair": "Deux Paires",
  "One Pair": "Paire",
  "Pair of": "Paire de",
  "High Card": "Carte Haute",
  " over ": " sur ",
  " high": " hauteur",
  " & ": " et ",
};

function translateHand(hand: string): string {
  let result = hand;
  for (const [en, fr] of Object.entries(HAND_NAMES_FR)) {
    result = result.replace(en, fr);
  }
  return result;
}

function evaluateHand(hand: { suit: string; value: string }[]): string {
  if (!hand || hand.length !== 5) return "";
  const valuesOrder: Record<string, number> = {
    "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
    "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14,
  };
  const valueCounts: Record<string, number> = {};
  const suits = hand.map((c) => c.suit);
  const valueNums = hand.map((c) => valuesOrder[c.value]).sort((a, b) => a - b);
  hand.forEach((c) => (valueCounts[c.value] = (valueCounts[c.value] || 0) + 1));
  const counts = Object.values(valueCounts).sort((a, b) => b - a);
  const isFlush = new Set(suits).size === 1;
  const isStraight =
    valueNums.every((v, i) => i === 0 || v === valueNums[i - 1] + 1) ||
    valueNums.toString() === "2,3,4,5,14";
  if (isFlush && isStraight && Math.min(...valueNums) === 10) return "Royal Flush";
  if (isFlush && isStraight) return "Straight Flush";
  if (counts[0] === 4) return "Four of a Kind";
  if (counts[0] === 3 && counts[1] === 2) return "Full House";
  if (isFlush) return "Flush";
  if (isStraight) return "Straight";
  if (counts[0] === 3) return "Three of a Kind";
  if (counts[0] === 2 && counts[1] === 2) return "Two Pair";
  if (counts[0] === 2) return "One Pair";
  return "High Card";
}

type Card = { suit: string; value: string };

export default function ShowdownPage() {
  const { user } = useUser();
  const router = useRouter();

  const [userTokens, setUserTokens] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [game, setGame] = useState<{ id: number } | null>(null);
  const [result, setResult] = useState<any>(null);
  const [opponentHand, setOpponentHand] = useState<Card[]>([]);
  const [playerHand, setPlayerHand] = useState<Card[]>([]);
  const [pot, setPot] = useState(0);
  const [betAmount, setBetAmount] = useState(10);
  const [revealing, setRevealing] = useState(false);

  // Stats
  const [stats, setStats] = useState({ played: 0, won: 0, lost: 0, tied: 0 });

  useEffect(() => { fetchTokens(); }, []);

  const fetchTokens = async () => {
    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) {
        setUserTokens(data.data.balance);
      } else {
        throw new Error(data.error || "Erreur inconnue");
      }
    } catch {
      setError("Impossible de charger les tokens.");
    } finally {
      setLoading(false);
    }
  };

  const initializeGame = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch("/api/initialize-poker-vs-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.error || "Erreur lors de l'initialisation");
        return;
      }
      setGame({ id: data.data.gameId });
      const playerCards = data.data.playerHand;
      const aiCards: Card[] = data.data.aiHand.map(() => ({ value: "?", suit: "?" }));
      setPlayerHand(playerCards);
      setOpponentHand(aiCards);
      setPot(data.data.pot ?? betAmount * 2);
      setUserTokens(data.data.newBalance);
      setResult(null);
    } catch {
      setError("Impossible de démarrer la partie");
    } finally {
      setLoading(false);
    }
  };

  const handlePlay = async () => {
    if (!game || revealing) return;
    try {
      setRevealing(true);
      playCardDraw();
      const res = await fetch("/api/handle-poker-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: game.id, action: "play" }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error);

      // Reveal AI hand with a short delay for drama
      await new Promise((r) => setTimeout(r, 600));
      const suitSymbols = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };
      const revealedHand = data.game.aiHand.map((c: any) => ({
        value: c.value,
        suit: suitSymbols[c.suit as keyof typeof suitSymbols] || c.suit,
      }));
      setOpponentHand(revealedHand);

      if (data.result) {
        setResult(data.result);
        if (data.result.won) {
          playVictory();
          confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 }, colors: ["#ffd700", "#ff00cc", "#00e5ff"] });
          setTimeout(() => confetti({ particleCount: 50, spread: 100, origin: { y: 0.5 }, colors: ["#ffd700", "#ffffff"] }), 400);
        } else {
          playDefeat();
        }
        setStats((s) => ({
          played: s.played + 1,
          won: data.result.won ? s.won + 1 : s.won,
          lost: !data.result.won && data.result.message.includes("tie") ? s.lost : !data.result.won ? s.lost + 1 : s.lost,
          tied: data.result.message.toLowerCase().includes("tie") ? s.tied + 1 : s.tied,
        }));
      }
      if (data.newBalance !== undefined) setUserTokens(data.newBalance);
      setPot(data.game.pot || 0);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRevealing(false);
    }
  };

  const handleFold = async () => {
    if (!game) return;
    try {
      const res = await fetch("/api/handle-poker-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: game.id, action: "fold" }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error);

      const suitSymbols = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };
      const revealedHand = (data.game?.aiHand || []).map((c: any) => ({
        value: c.value,
        suit: c.suit === "?" ? "?" : (suitSymbols[c.suit as keyof typeof suitSymbols] || c.suit),
      }));
      setOpponentHand(revealedHand);

      if (data.result) {
        setResult(data.result);
        playDefeat();
        setStats((s) => ({
          ...s,
          played: s.played + 1,
          lost: s.lost + 1,
        }));
      }
      if (data.newBalance !== undefined) setUserTokens(data.newBalance);
      setPot(0);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const getHighlightValues = (hand: Card[]) => {
    if (!hand || hand.length === 0) return { values: [] as string[], color: "yellow" };
    const visible = hand.filter((c) => c.value !== "?");
    if (visible.length === 0) return { values: [], color: "yellow" };
    const valueCounts: Record<string, number> = {};
    visible.forEach((c) => (valueCounts[c.value] = (valueCounts[c.value] || 0) + 1));
    const pairs = Object.keys(valueCounts).filter((v) => valueCounts[v] > 1);
    if (pairs.length > 0) return { values: pairs, color: "yellow" };
    const valuesOrder: Record<string, number> = {
      "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
      "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14,
    };
    const sorted = [...visible].sort((a, b) => valuesOrder[b.value] - valuesOrder[a.value]);
    return { values: [sorted[0].value], color: "yellow" };
  };

  const CardFace = ({ card, highlight }: { card: Card; highlight?: boolean }) => {
    if (card.value === "?") {
      return (
        <div className="h-24 w-16 sm:h-28 sm:w-20 md:h-32 md:w-24 relative rounded-lg overflow-hidden
          bg-gradient-to-br from-[#1a0a2e] via-[#0d0020] to-[#05000d]
          shadow-[0_0_20px_rgba(255,0,204,0.4)] border-2 border-[#ff00cc]/40">
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-4xl opacity-30 select-none">🂠</span>
          </div>
        </div>
      );
    }
    const isRed = card.suit === "♥" || card.suit === "♦";
    const suitColor = isRed ? "#c0392b" : "#1a1a2e";
    return (
      <div className={`h-24 w-16 sm:h-28 sm:w-20 md:h-32 md:w-24 relative rounded-xl flex flex-col
        bg-gradient-to-b from-white via-gray-50 to-gray-100
        shadow-lg border-2 transition-all duration-300
        ${highlight ? "border-[#ffd700] shadow-[0_0_20px_rgba(255,215,0,0.6)] scale-105" : "border-gray-300 shadow-gray-400/30"}`}>
        <div className="absolute top-1 left-1.5 flex flex-col items-center leading-none">
          <span className="text-xs sm:text-sm font-bold" style={{ color: suitColor }}>{card.value}</span>
          <span className="text-[10px] sm:text-xs" style={{ color: suitColor }}>{card.suit}</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <span className="text-2xl sm:text-3xl md:text-4xl" style={{ color: suitColor }}>{card.suit}</span>
        </div>
        <div className="absolute bottom-1 right-1.5 flex flex-col items-center leading-none rotate-180">
          <span className="text-xs sm:text-sm font-bold" style={{ color: suitColor }}>{card.value}</span>
          <span className="text-[10px] sm:text-xs" style={{ color: suitColor }}>{card.suit}</span>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#020108] via-[#0a0a1a] to-[#050510] flex items-center justify-center">
        <div className="text-[#ffd700] text-xl animate-pulse">Chargement...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#020108] via-[#0a0a1a] to-[#050510] pb-24 pt-20 md:pb-8 relative">
      <div className="fixed inset-0 pointer-events-none z-0 opacity-[0.03]"
        style={{ backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,215,0,0.15) 2px, rgba(255,215,0,0.15) 4px)" }} />
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto max-w-4xl px-3 py-6 sm:px-4 sm:py-8 relative z-10">
        {/* Title */}
        <h1 className="text-3xl sm:text-5xl font-black tracking-widest uppercase text-transparent bg-clip-text bg-gradient-to-r from-[#ffd700] via-amber-400 to-[#ffd700] text-center mb-2 drop-shadow-[0_0_12px_rgba(255,215,0,0.5)]">
          🃏 Confrontation
        </h1>
        <p className="text-sm text-[#ffd700]/60 text-center mb-4">5-Card Showdown</p>

        {/* Balance */}
        <div className="flex items-center justify-center gap-2 mb-4">
          <span className="text-[#ffd700]/70 text-sm">🪙 Jetons:</span>
          <span className="text-lg font-bold text-[#ffd700] drop-shadow-[0_0_8px_rgba(255,215,0,0.4)]">{userTokens}</span>
        </div>

        {error && (
          <div className="mb-4 rounded bg-red-950/30 backdrop-blur-sm p-3 text-red-300 border border-red-500/40 text-center">
            {error}
          </div>
        )}

        {/* Stats bar */}
        {stats.played > 0 && (
          <div className="mb-4 flex justify-center gap-4 text-xs sm:text-sm">
            <span className="text-[#b0b0ff]/60">Joué: <strong className="text-white">{stats.played}</strong></span>
            <span className="text-green-400/80">Gagné: <strong>{stats.won}</strong></span>
            <span className="text-red-400/80">Perdu: <strong>{stats.lost}</strong></span>
            {stats.tied > 0 && <span className="text-yellow-400/80">Égalité: <strong>{stats.tied}</strong></span>}
          </div>
        )}

        {/* Pre-game setup */}
        {!game && (
          <div className="text-center mt-8">
            <div className="flex justify-center items-center gap-3 mb-3">
              <label className="text-[#ffd700] font-semibold text-sm">Miser:</label>
              <div className="flex gap-1.5 flex-wrap justify-center max-w-xs">
                {CHIP_VALUES.map((v) => (
                  <button
                    key={v}
                    onClick={() => setBetAmount(v)}
                    className={`w-12 h-8 rounded-full text-xs font-bold border transition-all active:scale-95 ${
                      betAmount === v
                        ? "bg-[#ffd700] text-black border-[#ffd700] shadow-[0_0_12px_rgba(255,215,0,0.5)]"
                        : "bg-[#0a0a1a] text-[#ffd700]/70 border-[#ffd700]/30 hover:border-[#ffd700]/60 hover:bg-[#ffd700]/10"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  value={betAmount}
                  min={0}
                  max={userTokens}
                  onChange={(e) => setBetAmount(parseInt(e.target.value) || 0)}
                  onBlur={() => { if (!betAmount || betAmount < 1) setBetAmount(1); }}
                  className="w-20 px-2 py-1.5 rounded bg-[#0a0a1a] border border-[#ffd700]/30 text-white text-center focus:border-[#ffd700] focus:ring-1 focus:ring-[#ffd700]/50"
                />
                <button onClick={() => setBetAmount(Math.max(1, Math.floor(userTokens / 2)))} className="px-2 py-1 rounded text-xs font-bold border border-[#ffd700]/30 bg-[#ffd700]/15 text-[#ffd700] hover:bg-[#ffd700]/25 transition">½</button>
                <button onClick={() => setBetAmount(userTokens)} className="px-2 py-1 rounded text-xs font-bold border border-[#ffd700]/30 bg-[#ffd700]/15 text-[#ffd700] hover:bg-[#ffd700]/25 transition">TOUT</button>
              </div>
            </div>
            <div className="flex justify-center gap-4 mt-4 px-4">
              <button
                onClick={() => router.push("/casino/poker/multi")}
                className="flex-1 max-w-xs rounded-xl border border-[#ff00cc]/40 bg-[#ff00cc]/15 px-4 py-3 text-sm font-medium text-[#ffb0ff] hover:bg-[#ff00cc]/30 transition shadow-[0_0_12px_rgba(255,0,204,0.2)]"
              >
                Texas Hold'em ♦️
              </button>
              <button
                onClick={initializeGame}
                className="flex-1 max-w-xs rounded-xl border border-[#ffd700]/40 bg-[#ffd700]/15 px-4 py-3 text-sm font-bold text-[#ffd700] hover:bg-[#ffd700]/30 active:scale-95 transition shadow-[0_0_12px_rgba(255,215,0,0.2)]"
              >
                Distribuer 🃏
              </button>
            </div>
          </div>
        )}

        {/* Game in progress */}
        {game && (
          <div className="mx-auto mt-6 w-full max-w-3xl rounded-xl border border-[#ffd700]/20 bg-[#0a0a1a]/90 p-4 shadow-[0_0_40px_rgba(255,215,0,0.1)] backdrop-blur-md sm:p-6">
            {/* Result display */}
            {result && (
              <div className="mb-6 text-center space-y-3">
                <p className={`text-xl font-bold drop-shadow-[0_0_10px_currentColor] ${
                  result.won ? "text-[#ffd700]" : "text-red-400"
                }`}>
                  {result.message}
                </p>
                {result.won && (
                  <p className="text-[#ffd700] font-extrabold text-lg drop-shadow-[0_0_6px_rgba(255,215,0,0.6)]">
                    +{result.winAmount} jetons 🎉
                  </p>
                )}
                <button
                  onClick={() => {
                    setResult(null);
                    setGame(null);
                    setPlayerHand([]);
                    setOpponentHand([]);
                    initializeGame();
                  }}
                  className="bg-gradient-to-r from-[#ffd700]/80 to-amber-400/80 hover:from-[#ffd700] hover:to-amber-400 text-black font-bold px-6 py-3 rounded-full text-sm border border-[#ffd700]/30 shadow-[0_0_20px_rgba(255,215,0,0.3)] transition"
                >
                  🔄 Rejouer
                </button>
              </div>
            )}

            {/* Action buttons */}
            {!result && (
              <div className="flex flex-wrap justify-center items-center gap-4 mb-6">
                <button
                  onClick={handleFold}
                  className="bg-red-900/40 hover:bg-red-800/50 px-6 py-3 rounded-full font-bold text-red-300 border border-red-500/40 shadow-[0_0_12px_rgba(255,0,0,0.3)] text-sm transition"
                >
                  Se Coucher
                </button>
                <button
                  onClick={handlePlay}
                  disabled={revealing}
                  className="bg-gradient-to-r from-[#ffd700]/30 to-amber-400/30 hover:from-[#ffd700]/50 hover:to-amber-400/50 px-6 py-3 rounded-full font-bold text-white border border-[#ffd700]/40 shadow-[0_0_15px_rgba(255,215,0,0.3)] text-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {revealing ? "Révélation..." : "Révéler les cartes"}
                </button>
              </div>
            )}

            {/* Player & AI hands */}
            <div className="flex justify-center flex-wrap gap-6 mb-4">
              {/* Player */}
              <div className="text-center">
                <h3 className="text-[#ffd700] mb-2 drop-shadow-[0_0_6px_rgba(255,215,0,0.4)] text-sm font-semibold">Votre main</h3>
                <div className="flex gap-1.5 justify-center">
                  {playerHand.map((c, i) => (
                    <CardFace key={i} card={c} highlight={getHighlightValues(playerHand).values.includes(c.value)} />
                  ))}
                </div>
                {playerHand.length === 5 && (
                  <div className="mt-2 text-sm font-bold text-[#ffd700] drop-shadow-[0_0_6px_rgba(255,215,0,0.4)]">
                    {translateHand(evaluateHand(playerHand))}
                  </div>
                )}
              </div>

              {/* AI */}
              <div className="text-center">
                <h3 className="text-[#ff00cc] mb-2 drop-shadow-[0_0_6px_rgba(255,0,204,0.4)] text-sm font-semibold">Adversaire</h3>
                <div className="flex gap-1.5 justify-center">
                  {opponentHand.map((c, i) => (
                    <CardFace key={i} card={c} highlight={getHighlightValues(opponentHand).values.includes(c.value)} />
                  ))}
                </div>
                {opponentHand.length === 5 && !opponentHand.some((c) => c.value === "?") && (
                  <div className="mt-2 text-sm font-bold text-[#ff00cc] drop-shadow-[0_0_6px_rgba(255,0,204,0.4)]">
                    {translateHand(evaluateHand(opponentHand))}
                  </div>
                )}
              </div>
            </div>

            {/* Pot */}
            <div className="text-center font-black text-lg text-transparent bg-clip-text bg-gradient-to-r from-[#ffd700] to-amber-400 drop-shadow-[0_0_8px_rgba(255,215,0,0.5)]">
              Pot: {pot} jetons
            </div>
          </div>
        )}

        {/* Hand rankings legend */}
        <div className="mt-6 w-full bg-[#0a0a1a]/90 text-white p-4 rounded-xl border border-[#ffd700]/15 shadow-[0_0_20px_rgba(255,215,0,0.05)] backdrop-blur-md">
          <h3 className="text-[#ffd700] font-bold mb-2 text-center drop-shadow-[0_0_8px_rgba(255,215,0,0.3)]">
            Mains (Probabilités)
          </h3>
          <ul className="flex flex-wrap justify-center gap-x-6 gap-y-1 text-sm text-[#b0b0ff]/60">
            <li>Quinte Flush Royale (0,0001%)</li>
            <li>Quinte Flush (0,001%)</li>
            <li>Carré (0,02%)</li>
            <li>Full (0,1%)</li>
            <li>Couleur (0,2%)</li>
            <li>Quinte (0,4%)</li>
            <li>Brelan (2,11%)</li>
            <li>Deux Paires (4,75%)</li>
            <li>Paire (42,26%)</li>
            <li>Carte Haute (50,12%)</li>
          </ul>
        </div>
      </div>
      <Footer />
    </div>
  );
}
