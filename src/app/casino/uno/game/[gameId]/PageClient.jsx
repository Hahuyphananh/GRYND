"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { usePostHog } from "posthog-js/react";
import UnoCard, { UNO_PALETTE } from "../../../../../components/UnoCard";
import UnoBack from "../../../../../components/UnoBack";
import NavigationBar from "../../../../../components/navigation-bar";
import Footer from "../../../../../components/Footer";
import { useFirstVisitRules, RulesModal } from "../../../../../components/lobby/PvpLobby";
import MatchWaiting from "../../../../../components/lobby/MatchWaiting";
import { useSocket } from "../../../../../context/SocketProvider";
import useGamePresence from "../../../../../hooks/useGamePresence";
import {
  celebrateWin,
  fireConfetti,
  gameOverModal,
  turnBanner,
} from "../../../../../lib/animations";
import {
  playVictory,
  playDefeat,
  playTurnSwitch,
  playCardPlace,
  playCardDraw,
} from "../../../../../lib/gameAudio";
import GameSessionHost from "../../../../../components/GameSessionHost";

import {
  IconRobot,
  IconUser,
  IconTrophy,
  IconSkull,
  IconSparkles,
  IconPalette,
  IconArrowLeft,
  IconArrowRight,
  IconX,
  IconHistory,
} from "@tabler/icons-react";
import { useTranslation } from "../../../../../hooks/useTranslation";
export default function UnoGamePage() {
  const { gameId } = useParams();
  const router = useRouter();
  const { socket } = useSocket();
  const posthog = usePostHog();
  const { t } = useTranslation();
  const [game, setGame] = useState(null);
  const [gameMode, setGameMode] = useState("ai");
  const [playerHand, setPlayerHand] = useState([]);
  const [aiHandCount, setAiHandCount] = useState(0);
  const [topCard, setTopCard] = useState(null);
  const [isPlayerTurn, setIsPlayerTurn] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  // STAKES ARE RETIRED (src/lib/games/stakes.js): nothing is staked and no
  // token balance is shown.
  const betAmount = 0;
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [pendingCard, setPendingCard] = useState(null);
  const [turnHistory, setTurnHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(null);
  const [showRules, setShowRules] = useState(false);
  const firstVisitRules = useFirstVisitRules("uno-game");
  useEffect(() => {
    if (firstVisitRules) setShowRules(true);
  }, [firstVisitRules]);
  const [isResigning, setIsResigning] = useState(false);
  const [endPopup, setEndPopup] = useState(null);
  const [replayRequested, setReplayRequested] = useState(false);
  const [opponentReplayRequested, setOpponentReplayRequested] = useState(false);
  const [returnChosen, setReturnChosen] = useState(false);
  const [replaySecondsLeft, setReplaySecondsLeft] = useState(15);
  const [turnBanner, setTurnBanner] = useState(null);
  const [gameOver, setGameOver] = useState(false);
  const [waitingForOpponent, setWaitingForOpponent] = useState(false);
  const waitingPollRef = useRef(null);
  const prevIsPlayerTurnRef = useRef(null);
  const replayClientIdRef = useRef(Math.random().toString(36).slice(2));
  const openEndPopup = (result, reason = "finished") => {
    setEndPopup({
      result,
      reason,
      openedAt: Date.now(),
    });
    setReplayRequested(false);
    setOpponentReplayRequested(false);
    setReturnChosen(false);
    setReplaySecondsLeft(15);
    setGameOver(true);
    if (result === "win") {
      celebrateWin();
      playVictory();
    } else {
      playDefeat();
    }
    posthog?.capture("neon_flush_game_ended", {
      result,
      reason,
      mode: gameMode,
      bet_amount: betAmount,
      game_id: game?.id,
    });
  };
  const closeToUnoLobby = () => {
    setReturnChosen(true);
    if (socket && game?.id && gameMode === "online") {
      socket.emit("room_event", {
        roomId: `uno:end:${game.id}`,
        event: "uno:end:return",
        payload: {
          gameId: game.id,
          clientId: replayClientIdRef.current,
        },
      });
    }
    returnToLobby();
  };
  const requestReplay = () => {
    if (!endPopup || returnChosen) return;
    setReplayRequested(true);
    if (gameMode !== "online") {
      initializeGame();
      return;
    }
    if (socket && game?.id) {
      socket.emit("room_event", {
        roomId: `uno:end:${game.id}`,
        event: "uno:end:replay",
        payload: {
          gameId: game.id,
          clientId: replayClientIdRef.current,
        },
      });
    }
  };
  useGamePresence({
    gameKey: "uno",
    gameId: Number(game?.id),
    enabled: Boolean(game?.id),
  });
  useEffect(() => {
    if (
      prevIsPlayerTurnRef.current !== null &&
      prevIsPlayerTurnRef.current !== isPlayerTurn &&
      game
    ) {
      setTurnBanner(
        isPlayerTurn ? "Your Turn" : gameMode === "ai" ? "AI's Turn" : "Opponent's Turn"
      );
      playTurnSwitch(isPlayerTurn);
      setTimeout(() => setTurnBanner(null), 1800);
    }
    prevIsPlayerTurnRef.current = isPlayerTurn;
  }, [isPlayerTurn, game]);
  useEffect(() => {
    if (!socket || !game?.id || gameMode !== "online" || !endPopup) return;
    const roomId = `uno:end:${game.id}`;
    const handleReplay = (payload) => {
      if (payload?.gameId !== game.id || payload?.clientId === replayClientIdRef.current) return;
      setOpponentReplayRequested(true);
    };
    const handleReturn = (payload) => {
      if (payload?.gameId !== game.id || payload?.clientId === replayClientIdRef.current) return;
      setReturnChosen(true);
    };
    socket.emit("join_room", {
      roomId,
    });
    socket.on("uno:end:replay", handleReplay);
    socket.on("uno:end:return", handleReturn);
    return () => {
      socket.emit("leave_room", {
        roomId,
      });
      socket.off("uno:end:replay", handleReplay);
      socket.off("uno:end:return", handleReturn);
    };
  }, [socket, game?.id, gameMode, endPopup]);
  useEffect(() => {
    if (!endPopup) return;
    const deadline = endPopup.openedAt + 15000;
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setReplaySecondsLeft(remaining);
      if (remaining <= 0) {
        clearInterval(id);
        returnToLobby();
      }
    }, 250);
    return () => clearInterval(id);
  }, [endPopup]);
  useEffect(() => {
    if (gameMode === "online" && replayRequested && opponentReplayRequested) {
      returnToLobby();
      setMessage(t("neonFlush.replayAccepted"));
    }
  }, [gameMode, replayRequested, opponentReplayRequested]);
  const checkForWinner = async (gameId) => {
    try {
      const res = await fetch("/api/uno/determine-winner", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          gameId,
        }),
      });
      const data = await res.json();
      if (data.winner) {
        if (gameMode === "online") {
          const youWon = data.result === "win";
          setMessage(youWon ? t("neonFlush.youWon") : t("neonFlush.opponentWon"));
        } else {
          setMessage(data.winner === "player" ? t("neonFlush.youWon") : t("neonFlush.opponentWon"));
        }
        setIsPlayerTurn(false);
        openEndPopup(data.result === "win" || data.winner === "player" ? "win" : "loss");
      }
    } catch (err) {
      console.error("Erreur lors de la vérification du gagnant:", err);
    }
  };
  const initializeGame = async () => {
    setLoading(true);
    const res = await fetch("/api/uno/initialize-vs-ai", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        betAmount: 0,
      }),
    });
    const data = await res.json();
    if (data.success) {
      setGameMode("ai");
      setGame(data.data);
      setPlayerHand(data.data.playerHand);
      setAiHandCount(data.data.aiHand.length);
      setTopCard(data.data.topCard);
      setTurnHistory(data.data.topCard ? [data.data.topCard] : []);
      setHistoryIndex(null);
      setIsPlayerTurn(true);
      setGameOver(false);
      setMessage(t("neonFlush.yourTurn"));
      setEndPopup(null);
      setTokens({
        balance: data.data.newBalance,
      });
      posthog?.capture("neon_flush_game_started", {
        mode: "ai",
        bet_amount: 0,
        game_id: data.data.id,
      });
    } else {
      setMessage(t("neonFlush.initError"));
    }
    setLoading(false);
  };
  const handleAITurn = async (gameId) => {
    try {
      const res = await fetch("/api/uno/ai-turn", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          gameId,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setPlayerHand(data.data.playerHand);
        setAiHandCount(data.data.aiHandCount);
        setTopCard(data.data.topCard);
        setTurnHistory((prev) => [...prev, data.data.topCard]);
        setHistoryIndex(null);
        setIsPlayerTurn(data.data.isPlayerTurn);
        setMessage(data.data.message || t("neonFlush.yourTurn"));
        setTokens({
          balance: data.data.newBalance,
        });
        await checkForWinner(gameId);
      }
    } catch (err) {
      console.error("Erreur IA:", err);
    }
  };
  const sendPlayCard = async (card, chosenColor = null) => {
    setLoading(true);
    if ((card.color === "wild" || card.color === "black") && !chosenColor) {
      setPendingCard(card);
      setShowColorPicker(true);
      setLoading(false);
      return;
    }
    const isWildDrawFour = card.value?.toLowerCase()?.replace(/\s/g, "") === "wilddrawfour";
    const cardsLeftAfterPlay = playerHand.length - 1;
    const res = await fetch("/api/uno/play-card", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        gameId: game.id,
        card,
        chosenColor,
      }),
    });
    const data = await res.json();
    if (data.success) {
      setPlayerHand(data.data.playerHand);
      setTopCard(data.data.topCard);
      setTurnHistory((prev) => [...prev, data.data.topCard]);
      setHistoryIndex(null);
      setAiHandCount(data.data.aiHandCount ?? data.data.opponentHandCount ?? 0);
      setIsPlayerTurn(data.data.isPlayerTurn);
      setMessage(data.data.message || t("neonFlush.yourTurn"));
      setPendingCard(null);
      setShowColorPicker(false);
      playCardPlace();
      posthog?.capture("neon_flush_card_played", {
        color: card.color,
        value: card.value,
        mode: gameMode,
        game_id: game.id,
        cards_left: data.data.playerHand?.length ?? 0,
      });
      if (isWildDrawFour) {
        fireConfetti({
          particleCount: 50,
          spread: 70,
          origin: {
            x: 0.5,
            y: 0.5,
          },
          colors: ["#a855f7", "#22d3ee", "#fbbf24", "#f472b6"],
        });
        setTimeout(
          () =>
            fireConfetti({
              particleCount: 30,
              spread: 50,
              origin: {
                x: 0.3,
                y: 0.5,
              },
              colors: ["#a855f7", "#fbbf24"],
            }),
          200
        );
      }
      if (cardsLeftAfterPlay === 1) {
        fireConfetti({
          particleCount: 40,
          spread: 60,
          origin: {
            x: 0.5,
            y: 0.6,
          },
          colors: ["#fbbf24", "#22c55e", "#facc15"],
        });
      }
      await checkForWinner(game.id);
      if (!data.data.isPlayerTurn && gameMode === "ai") {
        setTimeout(() => handleAITurn(game.id), 1000);
      }
    } else {
      setMessage(data.error);
    }
    setLoading(false);
  };
  const playCard = async (card) => {
    if (!isPlayerTurn || loading || historyIndex !== null) return;
    await sendPlayCard(card);
  };
  const waitForOnlineGameStart = (gameId) => {
    if (waitingPollRef.current) clearInterval(waitingPollRef.current);
    waitingPollRef.current = setInterval(async () => {
      try {
        const res2 = await fetch("/api/uno/check-game", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            gameId,
          }),
        });
        const d2 = await res2.json();
        if (d2.success && d2.status === "active") {
          clearInterval(waitingPollRef.current);
          waitingPollRef.current = null;
          setWaitingForOpponent(false);
          setGameMode("online");
          setGame(d2.data);
          setPlayerHand(d2.data.playerHand);
          setAiHandCount(d2.data.opponentHandCount);
          setTopCard(d2.data.topCard);
          setTurnHistory([d2.data.topCard]);
          const isMyTurn = d2.data.turn === d2.data.role;
          setIsPlayerTurn(isMyTurn);
          setMessage(
            isMyTurn ? t("neonFlush.gameFoundYouStart") : t("neonFlush.gameFoundOppStarts")
          );
          posthog?.capture("neon_flush_game_started", {
            mode: "online",
            bet_amount: betAmount,
            game_id: d2.data.id,
          });
        }
      } catch (err) {
        console.error("Erreur check-game:", err);
      }
    }, 3000);
  };
  const joinOnlineGame = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/uno/join-online", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          mode: "join-random",
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (waitingPollRef.current) clearInterval(waitingPollRef.current);
        waitingPollRef.current = null;
        setGameMode("online");
        setGame(data.data);
        setPlayerHand(data.data.playerHand);
        setAiHandCount(data.data.opponentHandCount);
        setTopCard(data.data.topCard);
        setTurnHistory([data.data.topCard]);
        const isMyTurn = data.data.turn === (data.data.role || "player2");
        setIsPlayerTurn(isMyTurn);
        setMessage(isMyTurn ? t("neonFlush.gameFoundYouStart") : t("neonFlush.gameFoundOppStarts"));
        setTokens({
          balance: data.data.newBalance,
        });
        posthog?.capture("neon_flush_game_started", {
          mode: "online",
          bet_amount: betAmount,
          game_id: data.data.id,
        });
      } else {
        setMessage(data.error || "Erreur lors de la recherche de partie");
      }
    } catch (err) {
      console.error("Erreur joinOnlineGame:", err);
      setMessage(t("neonFlush.searchFailed"));
    }
    setLoading(false);
  };
  useEffect(() => {
    if (!game?.id || gameMode !== "online") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/uno/check-game", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            gameId: game.id,
          }),
        });
        const data = await res.json();
        if (!data.success || !data.data) return;
        setPlayerHand(data.data.playerHand || []);
        setAiHandCount(data.data.opponentHandCount ?? aiHandCount);
        setTopCard(data.data.topCard);
        setIsPlayerTurn(data.data.turn === data.data.role);
        if (data.status === "finished" && !endPopup) {
          const youWon = data.data.winner === data.data.role;
          setMessage(youWon ? t("neonFlush.youWon") : t("neonFlush.opponentWon"));
          setIsPlayerTurn(false);
          openEndPopup(youWon ? "win" : "loss");
        }
        setTurnHistory((prev) => {
          const last = prev[prev.length - 1];
          const sameCard =
            last?.color === data.data.topCard?.color && last?.value === data.data.topCard?.value;
          return sameCard ? prev : [...prev, data.data.topCard];
        });
      } catch (err) {
        console.error("Erreur sync online:", err);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [game?.id, gameMode, aiHandCount, endPopup]);
  useEffect(() => {
    if (!gameId) return;
    let cancelled = false;
    const id = Number(gameId);
    const hydrate = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/uno/check-game", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            gameId: id,
          }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!data.success) {
          setMessage(data.error || t("neonFlush.initError"));
          return;
        }
        if (data.status === "waiting") {
          setGameMode("online");
          setGame({
            id,
          });
          setWaitingForOpponent(true);
          setMessage(t("neonFlush.waitingOpponent"));
          waitForOnlineGameStart(id);
          return;
        }
        setWaitingForOpponent(false);
        const d = data.data || {};
        if (d.mode === "online") {
          const isMyTurn = d.turn === d.role;
          setGameMode("online");
          setGame(d);
          setPlayerHand(d.playerHand || []);
          setAiHandCount(d.opponentHandCount ?? 0);
          setTopCard(d.topCard || null);
          setTurnHistory(d.topCard ? [d.topCard] : []);
          setIsPlayerTurn(isMyTurn);
          setMessage(
            isMyTurn ? t("neonFlush.gameFoundYouStart") : t("neonFlush.gameFoundOppStarts")
          );
          if (data.status === "finished" && d.winner) {
            openEndPopup(d.winner === d.role ? "win" : "loss");
          }
          return;
        }
        const isMyTurn = d.turn !== "ai";
        setGameMode("ai");
        setGame(d);
        setPlayerHand(d.playerHand || []);
        setAiHandCount(d.aiHandCount ?? 0);
        setTopCard(d.topCard || null);
        setTurnHistory(d.topCard ? [d.topCard] : []);
        setIsPlayerTurn(isMyTurn);
        setMessage(isMyTurn ? t("neonFlush.yourTurn") : t("neonFlush.aiPlaying"));
        if (!isMyTurn) setTimeout(() => handleAITurn(id), 600);
      } catch (err) {
        console.error("Erreur chargement de la partie Neon Flush:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    hydrate();
    return () => {
      cancelled = true;
      if (waitingPollRef.current) {
        clearInterval(waitingPollRef.current);
        waitingPollRef.current = null;
      }
    };
  }, [gameId]);
  const resignGame = async () => {
    if (!game?.id || isResigning) return;
    setIsResigning(true);
    try {
      const res = await fetch("/api/uno/resign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          gameId: game.id,
          gameMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || t("neonFlush.resignFailed"));
        return;
      }
      setMessage(gameMode === "online" ? t("neonFlush.resignedYou") : t("neonFlush.resignedAi"));
      setIsPlayerTurn(false);
      if (data.newBalance)
        setTokens({
          balance: data.newBalance,
        });
      openEndPopup("loss", "resigned");
    } catch (err) {
      console.error("Erreur resign:", err);
      alert(t("neonFlush.resignFailed"));
    }
    setIsResigning(false);
  };
  const drawCard = async () => {
    if (!isPlayerTurn || loading || historyIndex !== null) return;
    setLoading(true);
    const res = await fetch("/api/uno/draw-card", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        gameId: game.id,
      }),
    });
    const data = await res.json();
    if (data.success) {
      setPlayerHand(data.data.playerHand);
      setTopCard(data.data.topCard);
      setTurnHistory((prev) => [...prev, data.data.topCard]);
      setHistoryIndex(null);
      setAiHandCount(data.data.aiHandCount ?? data.data.opponentHandCount ?? aiHandCount);
      setIsPlayerTurn(data.data.isPlayerTurn);
      setMessage(gameMode === "ai" ? t("neonFlush.aiPlaying") : t("neonFlush.nextTurn"));
      playCardDraw();
      posthog?.capture("neon_flush_card_drawn", {
        mode: gameMode,
        game_id: game.id,
        hand_count: playerHand.length + 1,
      });
      await checkForWinner(game.id);
      if (gameMode === "ai") {
        setTimeout(() => handleAITurn(game.id), 1000);
      }
    } else {
      setMessage(data.error);
    }
    setLoading(false);
  };
  const returnToLobby = () => {
    if (waitingPollRef.current) clearInterval(waitingPollRef.current);
    waitingPollRef.current = null;
    setGame(null);
    setGameOver(false);
    setGameMode("ai");
    setPlayerHand([]);
    setAiHandCount(0);
    setTopCard(null);
    setIsPlayerTurn(true);
    setMessage("");
    setPendingCard(null);
    setShowColorPicker(false);
    setTurnHistory([]);
    setHistoryIndex(null);
    setEndPopup(null);
    setReplayRequested(false);
    setOpponentReplayRequested(false);
    setReturnChosen(false);
    router.push("/casino/uno");
  };
  const displayedCard = historyIndex === null ? topCard : turnHistory[historyIndex];
  const COLOR_NAME_KEYS = {
    red: "neonFlush.colorPink",
    blue: "neonFlush.colorCyan",
    green: "neonFlush.colorMint",
    yellow: "neonFlush.colorGold",
  };
  const currentColorName = (displayedCard?.color || topCard?.color || "red").toLowerCase();
  const currentColorHex = UNO_PALETTE[currentColorName] || UNO_PALETTE.red;
  const currentColorLabel = t(COLOR_NAME_KEYS[currentColorName] || "neonFlush.colorCyan");
  const historyColor = (card) => UNO_PALETTE[String(card?.color || "").toLowerCase()] || "#38FCFC";
  const historyLabel = (card) => {
    const v = String(card?.value || "")
      .toLowerCase()
      .replace(/\s/g, "");
    if (/^\d+$/.test(v)) return String(card.value);
    if (v === "drawtwo" || v === "+2") return "+2";
    if (v === "wilddrawfour" || v === "+4") return "+4";
    if (v === "wild") return "HACK";
    if (v === "skip") return "GLITCH";
    if (v === "reverse") return "LOOP";
    return String(card.value || "");
  };
  const goBackHistory = () =>
    setHistoryIndex((prev) =>
      turnHistory.length <= 1
        ? null
        : prev === null
          ? turnHistory.length - 2
          : Math.max(prev - 1, 0)
    );
  const goForwardHistory = () =>
    setHistoryIndex((prev) =>
      prev === null ? null : prev >= turnHistory.length - 2 ? null : prev + 1
    );
  const modalsNode = (
    <>
      <AnimatePresence>
        {endPopup && (
          <motion.div
            {...gameOverModal.backdrop}
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
            key={"uno-end-popup"}
          >
            <motion.div
              {...gameOverModal.panel}
              className={`relative w-full max-w-md overflow-hidden rounded-3xl border-4 p-6 text-center shadow-2xl ${endPopup.result === "win" ? "border-amber-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_60px_rgba(251,191,36,0.4)]" : "border-red-500 bg-gradient-to-b from-[#3a1a1a] to-[#2b0d0d] shadow-[0_0_60px_rgba(239,68,68,0.3)]"}`}
              key={"uno-end-panel"}
            >
              <motion.div
                initial={{
                  scale: 0,
                  rotate: -30,
                }}
                animate={{
                  scale: 1,
                  rotate: 0,
                }}
                transition={{
                  type: "spring",
                  stiffness: 300,
                  damping: 12,
                  delay: 0.3,
                }}
                className="mb-2 text-7xl"
              >
                {endPopup.result === "win" ? (
                  <IconTrophy size={64} className="text-amber-400" />
                ) : (
                  <IconSkull size={64} className="text-red-400" />
                )}
              </motion.div>
              <motion.h2
                initial={{
                  y: 20,
                  opacity: 0,
                }}
                animate={{
                  y: 0,
                  opacity: 1,
                }}
                transition={{
                  delay: 0.5,
                  duration: 0.4,
                }}
                className={`mt-3 text-4xl font-black uppercase ${endPopup.result === "win" ? "text-amber-300" : "text-red-400"}`}
              >
                {endPopup.result === "win"
                  ? "Victory"
                  : endPopup.reason === "resigned"
                    ? "Resigned"
                    : "Defeat"}
              </motion.h2>
              <motion.p
                initial={{
                  y: 20,
                  opacity: 0,
                }}
                animate={{
                  y: 0,
                  opacity: 1,
                }}
                transition={{
                  delay: 0.6,
                  duration: 0.4,
                }}
                className="mt-3 text-sm text-slate-200"
              >
                {endPopup.result === "win"
                  ? "You won the match."
                  : endPopup.reason === "resigned"
                    ? "You resigned the match."
                    : "Your opponent won the match."}
              </motion.p>
              {endPopup.result === "win" && (
                <motion.div
                  initial={{
                    opacity: 0,
                  }}
                  animate={{
                    opacity: 1,
                  }}
                  transition={{
                    delay: 1.0,
                  }}
                  className="mt-3 flex justify-center gap-1"
                >
                  {[0, 1, 2, 3, 4].map((i) => (
                    <motion.span
                      animate={{
                        y: [0, -6, 0],
                        opacity: [0.4, 1, 0.4],
                      }}
                      transition={{
                        duration: 0.8,
                        repeat: Infinity,
                        delay: i * 0.12,
                      }}
                      key={i}
                    >
                      <IconSparkles size={20} className="text-amber-300" />
                    </motion.span>
                  ))}
                </motion.div>
              )}
              {endPopup.result === "loss" && (
                <motion.p
                  initial={{
                    opacity: 0,
                  }}
                  animate={{
                    opacity: [0.5, 1, 0.5],
                  }}
                  transition={{
                    duration: 2,
                    repeat: Infinity,
                  }}
                  className="mt-3 text-sm text-gray-400"
                >
                  Better luck next time!
                </motion.p>
              )}
              <motion.p
                initial={{
                  y: 20,
                  opacity: 0,
                }}
                animate={{
                  y: 0,
                  opacity: 1,
                }}
                transition={{
                  delay: 0.7,
                  duration: 0.4,
                }}
                className="mt-4 text-xs font-bold uppercase tracking-widest text-yellow-200"
              >
                {"Replay window: "}
                {replaySecondsLeft}s
              </motion.p>
              <motion.div
                initial={{
                  y: 20,
                  opacity: 0,
                }}
                animate={{
                  y: 0,
                  opacity: 1,
                }}
                transition={{
                  delay: 0.8,
                  duration: 0.4,
                }}
                className="mt-6 grid gap-3 sm:grid-cols-2"
              >
                <button
                  onClick={requestReplay}
                  disabled={returnChosen || replayRequested}
                  className="rounded-xl border border-fuchsia-300/70 bg-fuchsia-500/20 px-4 py-3 font-black text-fuchsia-100 shadow-[0_0_18px_rgba(217,70,239,0.25)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {replayRequested
                    ? "Replay requested"
                    : gameMode === "online"
                      ? "Replay"
                      : "RUN IT BACK"}
                </button>
                <button
                  onClick={closeToUnoLobby}
                  className="rounded-xl border border-cyan-300/70 bg-cyan-400 px-4 py-3 font-black text-[#031026] shadow-[0_0_18px_rgba(34,211,238,0.35)]"
                >
                  Return to Lobby
                </button>
              </motion.div>
              {gameMode === "online" && (
                <motion.p
                  initial={{
                    opacity: 0,
                  }}
                  animate={{
                    opacity: 1,
                  }}
                  transition={{
                    delay: 1.0,
                    duration: 0.4,
                  }}
                  className="mt-3 text-xs text-slate-300"
                >
                  {returnChosen
                    ? "A player chose the lobby. Replay is disabled."
                    : opponentReplayRequested
                      ? "Opponent is ready for replay."
                      : "Both players must click replay before the timer ends."}
                </motion.p>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {turnBanner && (
          <motion.div
            {...turnBanner}
            className="fixed left-1/2 top-1/3 z-50 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-4 border-amber-400 bg-gradient-to-r from-amber-700 to-orange-700 px-10 py-6 shadow-[0_0_60px_rgba(251,191,36,0.5)]"
            key={"turn-banner"}
          >
            <motion.div
              initial={{
                scale: 0,
              }}
              animate={{
                scale: 1,
              }}
              transition={{
                delay: 0.15,
                type: "spring",
                stiffness: 400,
              }}
              className="text-center text-3xl font-black tracking-widest text-white drop-shadow-lg"
            >
              {turnBanner}
            </motion.div>
            <div className="mt-2 flex justify-center gap-1">
              {[0, 1, 2].map((i) => (
                <motion.div
                  className="h-2 w-2 rounded-full bg-amber-300"
                  animate={{
                    scale: [1, 1.8, 1],
                    opacity: [0.5, 1, 0.5],
                  }}
                  transition={{
                    duration: 0.8,
                    repeat: Infinity,
                    delay: i * 0.2,
                  }}
                  key={i}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {showRules && (
        <RulesModal
          title="How to Play"
          sections={[
            {
              heading: "Match the top card",
              body: (
                <>
                  Play a card matching the top card's color or number (or a Wild / action card).
                  First to empty their hand wins the round.
                </>
              ),
            },
            {
              heading: "Action cards",
              body: (
                <>
                  Skip, Reverse and Draw Two cards disrupt your opponent's turn; Wild and Wild Draw
                  Four change the color.
                </>
              ),
            },
            {
              heading: "Modes",
              body: (
                <>
                  Play vs AI for free, or go 1v1 online for a ranked match.
                  Winner takes the pot minus the platform fee.
                </>
              ),
            },
          ]}
          onClose={() => setShowRules(false)}
        />
      )}
    </>
  );
  const headerNode = (
    <>
      <h1 className="text-3xl mb-2 font-bold">
        {gameMode === "online" ? t("neonFlush.onlineTitle") : t("neonFlush.vsAiTitle")}
      </h1>
      <p className="mb-4 text-sm font-bold uppercase tracking-widest text-emerald-300">
        Free play · no tokens at stake
      </p>
      <div className="mb-5 text-center">
        <button
          onClick={() => setShowRules(true)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-300 transition-all duration-300 hover:bg-amber-500/20 hover:scale-105 shadow-[0_0_14px_rgba(251,191,36,0.15)]"
        >
          <IconPalette size={15} />
          {" How to Play"}
        </button>
      </div>
    </>
  );
  const opponentHandNode = (
    <div className="w-full">
      <div className="mb-1.5 flex items-center justify-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#9dd8ff]/80">
        {gameMode === "online" ? <IconUser size={13} /> : <IconRobot size={13} />}
        {gameMode === "online" ? t("neonFlush.opponentHand") : t("neonFlush.aiHand")}
        {!isPlayerTurn && gameMode === "ai" && (
          <IconRobot
            size={13}
            className="animate-spin"
            style={{
              animationDuration: "1s",
            }}
          />
        )}
      </div>
      <div className="flex justify-center">
        {Array(aiHandCount)
          .fill(0)
          .map((_, i) => (
            <div className="-ml-5 first:ml-0" key={i}>
              <UnoBack />
            </div>
          ))}
        {aiHandCount === 0 && <div className="h-20 w-14" />}
      </div>
    </div>
  );
  const centerRowNode = (
    <div className="my-3 flex items-center justify-center gap-4 sm:gap-6">
      <div className="flex flex-col items-center gap-1 rounded-xl border border-[#00e5ff]/30 bg-[#040d24]/80 px-3 py-2">
        <span className="text-[9px] font-bold uppercase tracking-widest text-[#9dd8ff]/70">
          {t("neonFlush.currentColor")}
        </span>
        <span className="flex items-center gap-1.5 text-sm font-black uppercase">
          <span
            className="inline-block h-3.5 w-3.5 rounded-full"
            style={{
              backgroundColor: currentColorHex,
              boxShadow: `0 0 10px ${currentColorHex}`,
            }}
          />
          <span
            style={{
              color: currentColorHex,
            }}
          >
            {currentColorLabel}
          </span>
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={goBackHistory}
          disabled={turnHistory.length <= 1 || historyIndex === 0}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#00e5ff]/40 text-[#00e5ff] transition-all hover:bg-[#00e5ff]/10 disabled:opacity-30"
        >
          <IconArrowLeft size={18} />
        </button>
        {displayedCard ? (
          <UnoCard color={displayedCard.color} value={displayedCard.value} onClick={() => {}} />
        ) : (
          <div className="h-20 w-14 rounded-lg border border-[#00e5ff]/20 bg-[#040d24]/60" />
        )}
        <button
          onClick={goForwardHistory}
          disabled={historyIndex === null}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#00e5ff]/40 text-[#00e5ff] transition-all hover:bg-[#00e5ff]/10 disabled:opacity-30"
        >
          <IconArrowRight size={18} />
        </button>
      </div>
      <div className="flex flex-col items-center gap-1 rounded-xl border border-[#00e5ff]/30 bg-[#040d24]/80 px-3 py-2">
        <span className="text-[9px] font-bold uppercase tracking-widest text-[#9dd8ff]/70">
          {t("neonFlush.currentCard")}
        </span>
        <span className="text-xs font-black uppercase text-[#d8fbff]/85">
          {displayedCard ? historyLabel(displayedCard) : "-"}
        </span>
      </div>
    </div>
  );
  const playerHandNode = (
    <div
      className={`flex flex-wrap justify-center gap-1.5 rounded-2xl p-2 ${isPlayerTurn ? "ring-2 ring-[#00e5ff]/50 shadow-[0_0_18px_rgba(0,229,255,0.25)]" : ""}`}
    >
      {playerHand.map((card, i) => (
        <UnoCard color={card.color} value={card.value} onClick={() => playCard(card)} key={i} />
      ))}
    </div>
  );
  const colorPickerNode = showColorPicker ? (
    <div className="absolute inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
      <div className="rounded-2xl border-2 border-[#00e5ff]/50 bg-[#040d24] p-6 shadow-[0_0_35px_rgba(0,229,255,0.35)] text-white flex flex-col items-center gap-5">
        <h2 className="mb-1 flex items-center gap-2 text-xl font-black uppercase tracking-widest text-[#00e5ff]">
          {t("neonFlush.chooseColor")} <IconPalette size={20} />
        </h2>
        <div className="grid grid-cols-2 gap-4">
          {[
            {
              color: "red",
              labelKey: "neonFlush.colorPink",
            },
            {
              color: "blue",
              labelKey: "neonFlush.colorCyan",
            },
            {
              color: "green",
              labelKey: "neonFlush.colorMint",
            },
            {
              color: "yellow",
              labelKey: "neonFlush.colorGold",
            },
          ].map(({ color, labelKey }) => (
            <button
              onClick={() => {
                setShowColorPicker(false);
                sendPlayCard(pendingCard, color);
              }}
              className="h-20 w-20 rounded-xl text-sm font-black uppercase text-[#031026] transition-transform hover:scale-105"
              style={{
                backgroundColor: UNO_PALETTE[color],
                boxShadow: `0 0 16px ${UNO_PALETTE[color]}66`,
              }}
              key={color}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>
    </div>
  ) : null;
  const tableNode = (
    <>
      {opponentHandNode}
      {colorPickerNode}
      {centerRowNode}
      {playerHandNode}
    </>
  );
  const controlsNode = (
    <>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
        <button
          onClick={drawCard}
          disabled={!isPlayerTurn || loading || historyIndex !== null}
          className="rounded-xl border-2 border-[#38fcfc]/80 bg-gradient-to-r from-[#00e5ff] to-[#38fcfc] px-6 py-2.5 font-black uppercase tracking-wider text-[#031026] shadow-[0_0_18px_rgba(0,229,255,0.5)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("neonFlush.drawCard")}
        </button>
        {game && !gameOver && (
          <button
            onClick={resignGame}
            disabled={isResigning}
            className="rounded-xl border-2 border-[#FF2D9B]/70 bg-[#FF2D9B]/15 px-5 py-2.5 font-black uppercase tracking-wider text-[#ff7ac2] shadow-[0_0_14px_rgba(255,45,155,0.3)] transition-all hover:bg-[#FF2D9B]/25 disabled:opacity-40"
          >
            {isResigning ? (
              t("neonFlush.resigning")
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <IconX size={15} /> {t("neonFlush.resign")}
              </span>
            )}
          </button>
        )}
        <button
          onClick={returnToLobby}
          className="rounded-xl border-2 border-[#FFD700]/70 bg-[#FFD700]/15 px-5 py-2.5 font-black uppercase tracking-wider text-[#FFE066] shadow-[0_0_14px_rgba(255,215,0,0.3)] transition-all hover:bg-[#FFD700]/25"
        >
          {t("neonFlush.lobby")}
        </button>
      </div>
      {message && (
        <p className="mt-3 text-center text-sm font-semibold text-yellow-300">{message}</p>
      )}
    </>
  );
  const historyInnerNode = (
    <>
      <div className="mb-2 flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-[#00e5ff]">
        <IconHistory size={14} /> {t("neonFlush.moveHistory")}
      </div>
      <div className="max-h-[540px] flex-1 space-y-1.5 overflow-y-auto pr-1">
        {turnHistory.length === 0 && (
          <p className="text-xs text-[#9dd8ff]/60">{t("neonFlush.noMovesYet")}</p>
        )}
        {turnHistory.map((card, i) => {
          const isCurrent = (historyIndex ?? turnHistory.length - 1) === i;
          return (
            <button
              onClick={() => setHistoryIndex(i === turnHistory.length - 1 ? null : i)}
              className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs transition-all ${isCurrent ? "border-[#00e5ff]/70 bg-[#00e5ff]/10 shadow-[0_0_10px_rgba(0,229,255,0.15)]" : "border-[#00e5ff]/20 bg-black/30 hover:border-[#00e5ff]/50"}`}
              key={i}
            >
              <span
                className="inline-block h-3 w-3 shrink-0 rounded-full"
                style={{
                  backgroundColor: historyColor(card),
                  boxShadow: `0 0 8px ${historyColor(card)}`,
                }}
              />
              <span className="truncate font-bold uppercase tracking-wide">
                {historyLabel(card)}
              </span>
              <span className="ml-auto text-[10px] text-[#9dd8ff]/60">#{i + 1}</span>
            </button>
          );
        })}
      </div>
    </>
  );
  const historyNode = (
    <aside className="hidden w-60 shrink-0 flex-col rounded-3xl border border-[#00e5ff]/30 bg-[#040d24]/70 p-3 backdrop-blur md:flex">
      {historyInnerNode}
    </aside>
  );
  const normalView = (
    <>
      {modalsNode}
      {headerNode}
      {!game ? null : (
        <div className="mb-16 flex w-full max-w-6xl items-stretch gap-4">
          <div className="relative flex min-w-0 flex-1 flex-col items-center justify-between overflow-hidden rounded-3xl border-2 border-[#00e5ff]/30 bg-gradient-to-br from-[#001a33] via-[#000d1f] to-[#000814] p-3 shadow-[0_0_35px_rgba(0,229,255,0.15)] sm:p-4">
            {tableNode}
            {controlsNode}
          </div>
          {historyNode}
        </div>
      )}
    </>
  );
  return (
    <div className="page-enter mt-0 flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#0a0118] to-[#061b3d] px-3 pb-24 pt-20 text-white sm:px-4 md:pb-8">
      <NavigationBar currentPath="/casino" />
      <AnimatePresence>
        {waitingForOpponent && (
          <MatchWaiting
            state="waiting"
            gameName={t("neonFlush.onlineTitle")}
            subtitle={t("neonFlush.waitingOpponent")}
            onLeave={returnToLobby}
          />
        )}
      </AnimatePresence>
      <GameSessionHost
        autoStart={Boolean(game)}
        autoStop={Boolean(endPopup)}
        gameLabel="neon-flush"
      >
        {normalView}
      </GameSessionHost>
      <Footer />
    </div>
  );
}
