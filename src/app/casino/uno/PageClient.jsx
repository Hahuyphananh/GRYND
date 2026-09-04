"use client";

import { useEffect, useRef, useState } from "react";
import { useDefaultWager } from "../../../hooks/useDefaultWager";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { usePostHog } from "posthog-js/react";
import UnoCard, { UNO_PALETTE } from "../../../components/UnoCard";
import UnoBack from "../../../components/UnoBack";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import { RulesModal, useFirstVisitRules } from "../../../components/lobby/PvpLobby";
import { useSocket } from "../../../context/SocketProvider";
import useGamePresence from "../../../hooks/useGamePresence";
import { celebrateWin, gameOverModal, turnBanner as turnBannerAnim, fireConfetti } from "../../../lib/animations";
import { playCardPlace, playCardDraw, playTurnSwitch, playVictory, playDefeat } from "../../../lib/gameAudio";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay, auto-starts when a real hand/match is active
// (`game` exists — the `!game` lobby stays unrecorded because autoStart
// is false) and auto-stops once the result popup is shown so the
// win/loss overlay is captured. The nav/footer/modals stay outside the
// shared CreatorModeHost recording viewport.
import CreatorModeHost from "../../../components/creator-mode/CreatorModeHost";
import { CreatorResponsiveLayout } from "../../../components/creator-mode/CreatorModeLayout";
import {
  IconRobot,
  IconUser,
  IconGlobe,
  IconDeviceGamepad2,
  IconRefresh,
  IconTrophy,
  IconSkull,
  IconSparkles,
  IconPalette,
  IconArrowLeft,
  IconArrowRight,
  IconX,
  IconHistory,
} from "@tabler/icons-react";
import { useTranslation } from "../../../hooks/useTranslation";

export default function UnoGamePage() {
  const router = useRouter();
  const { socket } = useSocket();
  const posthog = usePostHog();
  const { t } = useTranslation();

  const [game, setGame] = useState(null);
  const [gameMode, setGameMode] = useState("ai");
  const [lobbyMode, setLobbyMode] = useState("ai");
  const [playerHand, setPlayerHand] = useState([]);
  const [aiHandCount, setAiHandCount] = useState(0);
  const [topCard, setTopCard] = useState(null);
  const [isPlayerTurn, setIsPlayerTurn] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [betAmount, setBetAmount] = useDefaultWager("uno", 100);
  const [tokens, setTokens] = useState(null);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [pendingCard, setPendingCard] = useState(null);
  const [turnHistory, setTurnHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(null);
  const [showGameModeModal, setShowGameModeModal] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const firstVisitRules = useFirstVisitRules("uno");
  useEffect(() => {
    if (firstVisitRules) setShowRules(true);
  }, [firstVisitRules]);
  const [availableGames, setAvailableGames] = useState([]);
  const [isLoadingAvailableGames, setIsLoadingAvailableGames] = useState(false);
  const [waitingGameId, setWaitingGameId] = useState(null);
  const [isCancellingWaitingGame, setIsCancellingWaitingGame] = useState(false);
  const [isResigning, setIsResigning] = useState(false);
  const [endPopup, setEndPopup] = useState(null);
  const [replayRequested, setReplayRequested] = useState(false);
  const [opponentReplayRequested, setOpponentReplayRequested] = useState(false);
  const [returnChosen, setReturnChosen] = useState(false);
  const [replaySecondsLeft, setReplaySecondsLeft] = useState(15);
  const [turnBanner, setTurnBanner] = useState(null);
  const [gameOver, setGameOver] = useState(false);

  const waitingPollRef = useRef(null);
  const prevIsPlayerTurnRef = useRef(null);
  const replayClientIdRef = useRef(Math.random().toString(36).slice(2));

  const openEndPopup = (result, reason = "finished") => {
    setEndPopup({ result, reason, openedAt: Date.now() });
    setReplayRequested(false);
    setOpponentReplayRequested(false);
    setReturnChosen(false);
    setReplaySecondsLeft(15);
    setGameOver(true);
    if (result === "win") { celebrateWin(); playVictory(); } else { playDefeat(); }
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
        payload: { gameId: game.id, clientId: replayClientIdRef.current },
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
        payload: { gameId: game.id, clientId: replayClientIdRef.current },
      });
    }
  };

  useGamePresence({
    gameKey: "uno",
    gameId: Number(game?.id),
    enabled: Boolean(game?.id),
  });

  const fetchAvailableGames = async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (game || waitingGameId) return;
    setIsLoadingAvailableGames(true);
    try {
      const res = await fetch("/api/uno/available-games", {
        method: "GET",
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) setAvailableGames(data.data || []);
    } catch (err) {
      console.error("Erreur lors du chargement des parties disponibles:", err);
    }
    setIsLoadingAvailableGames(false);
  };

  useEffect(() => {
    fetchAvailableGames();
  }, []);

  // Turn banner animation
  useEffect(() => {
    if (prevIsPlayerTurnRef.current !== null && prevIsPlayerTurnRef.current !== isPlayerTurn && game) {
      setTurnBanner(isPlayerTurn ? "Your Turn" : gameMode === "ai" ? "AI's Turn" : "Opponent's Turn");
      playTurnSwitch(isPlayerTurn);
      setTimeout(() => setTurnBanner(null), 1800);
    }
    prevIsPlayerTurnRef.current = isPlayerTurn;
  }, [isPlayerTurn, game]);

  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:uno";
    const handleLobbyUpdate = () => fetchAvailableGames();
    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", handleLobbyUpdate);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", handleLobbyUpdate);
    };
  }, [socket, game, waitingGameId]);

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
    socket.emit("join_room", { roomId });
    socket.on("uno:end:replay", handleReplay);
    socket.on("uno:end:return", handleReturn);
    return () => {
      socket.emit("leave_room", { roomId });
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

  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const res = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        const data = await res.json();
        if (data.success) setTokens({ balance: data.data.balance });
      } catch (err) {
        console.error("Erreur lors du chargement des tokens:", err);
      }
    };
    fetchTokens();
  }, []);

  const checkForWinner = async (gameId) => {
    try {
      const res = await fetch("/api/uno/determine-winner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (data.winner) {
        if (gameMode === "online") {
          const youWon = data.result === "win";
          setMessage(youWon ? t("neonFlush.youWon") : t("neonFlush.opponentWon"));
        } else {
          setMessage(
            data.winner === "player" ? t("neonFlush.youWon") : t("neonFlush.opponentWon"),
          );
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
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ betAmount }),
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
      setTokens({ balance: data.data.newBalance });
      posthog?.capture("neon_flush_game_started", {
        mode: "ai",
        bet_amount: betAmount,
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
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
        setTokens({ balance: data.data.newBalance });
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: game.id, card, chosenColor }),
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

      // Hot streak confetti: Wild Draw Four
      if (isWildDrawFour) {
        fireConfetti({ particleCount: 50, spread: 70, origin: { x: 0.5, y: 0.5 }, colors: ["#a855f7", "#22d3ee", "#fbbf24", "#f472b6"] });
        setTimeout(() => fireConfetti({ particleCount: 30, spread: 50, origin: { x: 0.3, y: 0.5 }, colors: ["#a855f7", "#fbbf24"] }), 200);
      }

      // Hot streak confetti: UNO! (down to last card)
      if (cardsLeftAfterPlay === 1) {
        fireConfetti({ particleCount: 40, spread: 60, origin: { x: 0.5, y: 0.6 }, colors: ["#fbbf24", "#22c55e", "#facc15"] });
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId }),
        });
        const d2 = await res2.json();

        if (d2.success && d2.status === "active") {
          clearInterval(waitingPollRef.current);
          waitingPollRef.current = null;
          setWaitingGameId(null);
          setGameMode("online");
          setGame(d2.data);
          setPlayerHand(d2.data.playerHand);
          setAiHandCount(d2.data.opponentHandCount);
          setTopCard(d2.data.topCard);
          setTurnHistory([d2.data.topCard]);
          const isMyTurn = d2.data.turn === d2.data.role;
          setIsPlayerTurn(isMyTurn);
          setMessage(
            isMyTurn
              ? t("neonFlush.gameFoundYouStart")
              : t("neonFlush.gameFoundOppStarts")
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

  const cancelWaitingOnlineGame = async () => {
    if (!waitingGameId || isCancellingWaitingGame) return;
    setIsCancellingWaitingGame(true);
    try {
      const res = await fetch("/api/uno/cancel-waiting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ gameId: waitingGameId }),
      });
      const data = await res.json();

      if (data.success) {
        if (waitingPollRef.current) clearInterval(waitingPollRef.current);
        waitingPollRef.current = null;
        setWaitingGameId(null);
        setMessage(t("neonFlush.gameCancelled"));
        if (data.newBalance) setTokens({ balance: data.newBalance });
        fetchAvailableGames();
        socket?.emit("room_event", {
          roomId: "lobby:uno",
          event: "lobby:updated",
        });
      } else {
        setMessage(data.error || t("neonFlush.cancelFailed"));
      }
    } catch (err) {
      console.error("Erreur cancelWaitingOnlineGame:", err);
      setMessage(t("neonFlush.cancelFailed"));
    }
    setIsCancellingWaitingGame(false);
  };

  const joinSpecificOnlineGame = async (gameId) => {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/uno/join-online", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode: "join-specific", gameId }),
      });
      const data = await res.json();

      if (data.success) {
        setWaitingGameId(null);
        setGameMode("online");
        setGame(data.data);
        setPlayerHand(data.data.playerHand);
        setAiHandCount(data.data.opponentHandCount);
        setTopCard(data.data.topCard);
        setTurnHistory([data.data.topCard]);
        const isMyTurn = data.data.turn === (data.data.role || "player2");
        setIsPlayerTurn(isMyTurn);          setMessage(
            isMyTurn
              ? t("neonFlush.gameFoundYouStart")
              : t("neonFlush.gameFoundOppStarts")
          );
        setTokens({ balance: data.data.newBalance });
        posthog?.capture("neon_flush_game_started", { mode: "online", bet_amount: betAmount, game_id: data.data.id });
        fetchAvailableGames();
        socket?.emit("room_event", {
          roomId: "lobby:uno",
          event: "lobby:updated",
        });
      } else {
        setMessage(data.error || t("neonFlush.joinFailed"));
      }
    } catch (err) {
      console.error("Erreur joinSpecificOnlineGame:", err);
      setMessage(t("neonFlush.joinFailed"));
    }
    setLoading(false);
  };

  const joinOnlineGame = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/uno/join-online", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode: "join-random" }),
      });
      const data = await res.json();

      if (data.success) {
        if (waitingPollRef.current) clearInterval(waitingPollRef.current);
        waitingPollRef.current = null;
        setWaitingGameId(null);
        setGameMode("online");
        setGame(data.data);
        setPlayerHand(data.data.playerHand);
        setAiHandCount(data.data.opponentHandCount);
        setTopCard(data.data.topCard);
        setTurnHistory([data.data.topCard]);
        const isMyTurn = data.data.turn === (data.data.role || "player2");
        setIsPlayerTurn(isMyTurn);          setMessage(
            isMyTurn
              ? t("neonFlush.gameFoundYouStart")
              : t("neonFlush.gameFoundOppStarts")
          );
        setTokens({ balance: data.data.newBalance });
        posthog?.capture("neon_flush_game_started", { mode: "online", bet_amount: betAmount, game_id: data.data.id });
        fetchAvailableGames();
        socket?.emit("room_event", {
          roomId: "lobby:uno",
          event: "lobby:updated",
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

  const createOnlineGame = async () => {
    setLoading(true);
    setShowGameModeModal(false);
    try {
      const res = await fetch("/api/uno/join-online", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode: "create", betAmount }),
      });
      const data = await res.json();
      if (data.success && data.waiting) {
        setMessage(t("neonFlush.waitingOpponent"));
        setGameMode("online");
        setWaitingGameId(data.gameId);
        if (data.newBalance) setTokens({ balance: data.newBalance });
        waitForOnlineGameStart(data.gameId);
        fetchAvailableGames();
      } else {
        setMessage(data.error || t("neonFlush.createFailed"));
      }
    } catch (err) {
      console.error("Erreur createOnlineGame:", err);
      setMessage(t("neonFlush.createFailed"));
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!game?.id || gameMode !== "online") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/uno/check-game", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gameId: game.id }),
        });
        const data = await res.json();
        if (!data.success) return;

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

  const resignGame = async () => {
    if (!game?.id || isResigning) return;
    setIsResigning(true);
    try {
      const res = await fetch("/api/uno/resign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: game.id, gameMode }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || t("neonFlush.resignFailed"));
        return;
      }          setMessage(
            gameMode === "online" ? t("neonFlush.resignedYou") : t("neonFlush.resignedAi")
          );
      setIsPlayerTurn(false);
      if (data.newBalance) setTokens({ balance: data.newBalance });
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: game.id }),
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
    setWaitingGameId(null);
    setEndPopup(null);
    setReplayRequested(false);
    setOpponentReplayRequested(false);
    setReturnChosen(false);
    fetchAvailableGames();
  };

  const displayedCard = historyIndex === null ? topCard : turnHistory[historyIndex];

  // Neon Flush color + history helpers (shared by the board and the
  // move-history panel). The backend injects the chosen color into played
  // wild cards, so displayedCard.color is always concrete after a HACK.
  const COLOR_NAME_KEYS = {
    red: "neonFlush.colorPink",
    blue: "neonFlush.colorCyan",
    green: "neonFlush.colorMint",
    yellow: "neonFlush.colorGold",
  };
  const currentColorName = (displayedCard?.color || topCard?.color || "red").toLowerCase();
  const currentColorHex = UNO_PALETTE[currentColorName] || UNO_PALETTE.red;
  const currentColorLabel = t(COLOR_NAME_KEYS[currentColorName] || "neonFlush.colorCyan");
  const historyColor = (card) =>
    UNO_PALETTE[String(card?.color || "").toLowerCase()] || "#38FCFC";
  const historyLabel = (card) => {
    const v = String(card?.value || "").toLowerCase().replace(/\s/g, "");
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
          : Math.max(prev - 1, 0),
    );
  const goForwardHistory = () =>
    setHistoryIndex((prev) =>
      prev === null ? null : prev >= turnHistory.length - 2 ? null : prev + 1,
    );

  return (
    <div className="page-enter mt-0 flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#0a0118] to-[#061b3d] px-3 pb-24 pt-20 text-white sm:px-4 md:pb-8">
      <NavigationBar currentPath="/casino" />
      {/* Only the actual game + its result popup are recorded — the nav,
          footer and the `!game` lobby/finder stay outside (or unrecorded:
          autoStart is false in the lobby). Recording starts when a real
          hand is active and stops once the result is shown. */}
      <CreatorModeHost
        autoStart={Boolean(game)}
        autoStop={Boolean(endPopup)}
        gameLabel="neon-flush"
      >
      <CreatorResponsiveLayout>
      <AnimatePresence>
        {endPopup && (
          <motion.div
            key="uno-end-popup"
            {...gameOverModal.backdrop}
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
          >
            <motion.div
              key="uno-end-panel"
              {...gameOverModal.panel}
              className={`relative w-full max-w-md overflow-hidden rounded-3xl border-4 p-6 text-center shadow-2xl ${
                endPopup.result === "win"
                  ? "border-amber-400 bg-gradient-to-b from-[#1a3a1a] to-[#0d2b0d] shadow-[0_0_60px_rgba(251,191,36,0.4)]"
                  : "border-red-500 bg-gradient-to-b from-[#3a1a1a] to-[#2b0d0d] shadow-[0_0_60px_rgba(239,68,68,0.3)]"
              }`}
            >
              <motion.div
                initial={{ scale: 0, rotate: -30 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.3 }}
                className="mb-2 text-7xl"
              >
                {endPopup.result === "win" ? <IconTrophy size={64} className="text-amber-400" /> : <IconSkull size={64} className="text-red-400" />}
              </motion.div>
              <motion.h2
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.5, duration: 0.4 }}
                className={`mt-3 text-4xl font-black uppercase ${
                  endPopup.result === "win" ? "text-amber-300" : "text-red-400"
                }`}
              >
                {endPopup.result === "win"
                  ? "Victory"
                  : endPopup.reason === "resigned"
                    ? "Resigned"
                    : "Defeat"}
              </motion.h2>
              <motion.p
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.6, duration: 0.4 }}
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
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 1.0 }}
                  className="mt-3 flex justify-center gap-1"
                >
                  {[0, 1, 2, 3, 4].map((i) => (
                    <motion.span
                      key={i}
                      animate={{ y: [0, -6, 0], opacity: [0.4, 1, 0.4] }}
                      transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.12 }}
                    >
                      <IconSparkles size={20} className="text-amber-300" />
                    </motion.span>
                  ))}
                </motion.div>
              )}
              {endPopup.result === "loss" && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 2, repeat: Infinity }}
                  className="mt-3 text-sm text-gray-400"
                >
                  Better luck next time!
                </motion.p>
              )}
              <motion.p
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.7, duration: 0.4 }}
                className="mt-4 text-xs font-bold uppercase tracking-widest text-yellow-200"
              >
                Replay window: {replaySecondsLeft}s
              </motion.p>
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.8, duration: 0.4 }}
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
                      : "Play again"}
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
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 1.0, duration: 0.4 }}
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
      {/* Turn Banner */}
      <AnimatePresence>
        {turnBanner && (
          <motion.div
            key="turn-banner"
            {...turnBannerAnim}
            className="fixed left-1/2 top-1/3 z-50 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-4 border-amber-400 bg-gradient-to-r from-amber-700 to-orange-700 px-10 py-6 shadow-[0_0_60px_rgba(251,191,36,0.5)]"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.15, type: "spring", stiffness: 400 }}
              className="text-center text-3xl font-black tracking-widest text-white drop-shadow-lg"
            >
              {turnBanner}
            </motion.div>
            <div className="mt-2 flex justify-center gap-1">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  className="h-2 w-2 rounded-full bg-amber-300"
                  animate={{ scale: [1, 1.8, 1], opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.2 }}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <h1 className="text-3xl mb-2 font-bold">
        {gameMode === "online" ? t("neonFlush.onlineTitle") : t("neonFlush.vsAiTitle")}
      </h1>

      {tokens && (
        <p className="text-yellow-300 mb-4 text-lg">
          {t("neonFlush.tokens")} : {tokens.balance}
        </p>
      )}

      {/* How to Play — rules modal at the top of the lobby */}
      <div className="mb-5 text-center">
        <button
          onClick={() => setShowRules(true)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-bold text-amber-300 transition-all duration-300 hover:bg-amber-500/20 hover:scale-105 shadow-[0_0_14px_rgba(251,191,36,0.15)]"
        >
          <IconPalette size={15} /> How to Play
        </button>
      </div>
      {showRules && (
        <RulesModal
          title="How to Play"
          sections={[
            {
              heading: "Match the top card",
              body: (
                <>
                  Play a card matching the top card&apos;s color or number
                  (or a Wild / action card). First to empty their hand
                  wins the round.
                </>
              ),
            },
            {
              heading: "Action cards",
              body: (
                <>
                  Skip, Reverse and Draw Two cards disrupt your
                  opponent&apos;s turn; Wild and Wild Draw Four change the
                  color.
                </>
              ),
            },
            {
              heading: "Modes",
              body: (
                <>
                  Play vs AI for free (no tokens wagered), or go 1v1
                  online for a wagered match. Winner takes the pot minus
                  the house fee.
                </>
              ),
            },
          ]}
          onClose={() => setShowRules(false)}
        />
      )}

      {!game ? (
        <div className="casino-surface flex w-full max-w-4xl flex-col items-center justify-center rounded-[1.5rem] border border-amber-700/60 bg-black/40 p-4 text-center shadow-[0_0_28px_rgba(251,191,36,0.12)] sm:aspect-[2/1] sm:rounded-[2rem] sm:p-8">
        <h2 className="text-2xl font-bold mb-6 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.4)]">{t("neonFlush.prepare")}</h2>

        {/* Mode toggle: free-play AI vs wagered 1v1 online */}
        <div className="mb-4 grid grid-cols-2 gap-2 w-full max-w-xs">
          <button
            onClick={() => setLobbyMode("ai")}
            className={`rounded-lg px-4 py-2 text-sm font-bold transition ${
              lobbyMode === "ai"
                ? "border-b-4 border-amber-700 bg-amber-500 text-black shadow-[0_0_12px_rgba(251,191,36,0.4)]"
                : "border border-gray-600 bg-gray-800/50 text-gray-400 hover:border-amber-600/50 hover:text-amber-200"
            }`}
          >
            <span className="inline-flex items-center gap-1.5"><IconRobot size={16} /> {t("neonFlush.vsAi")}</span>
          </button>
          <button
            onClick={() => setLobbyMode("online")}
            className={`rounded-lg px-4 py-2 text-sm font-bold transition ${
              lobbyMode === "online"
                ? "border-b-4 border-cyan-700 bg-cyan-500 text-black shadow-[0_0_12px_rgba(34,211,238,0.35)]"
                : "border border-gray-600 bg-gray-800/50 text-gray-400 hover:border-cyan-600/50 hover:text-cyan-200"
            }`}
          >
            <span className="inline-flex items-center gap-1.5"><IconGlobe size={16} /> {t("neonFlush.online")}</span>
          </button>
        </div>

        {lobbyMode === "ai" ? (
          <div className="mb-6 rounded-lg border-2 border-dashed border-amber-400/40 bg-amber-500/10 p-3 text-center w-full max-w-xs">
            <p className="flex items-center justify-center gap-1.5 text-xs font-bold uppercase tracking-widest text-amber-300"><IconDeviceGamepad2 size={14} /> {t("neonFlush.freePlay")}</p>
            <p className="mt-1 text-[10px] text-amber-200/70">{t("neonFlush.freePlayHint")}</p>
          </div>
        ) : (
          <label className="mb-6 text-lg font-semibold flex flex-col items-center">
            <span className="mb-2 text-amber-200">{t("neonFlush.wager")} :</span>
            <input
              type="number"
              value={betAmount}
              onChange={(e) => setBetAmount(Number(e.target.value))}
              className="bg-[#020617] border border-amber-600/50 text-white px-3 py-1 rounded text-center w-32 focus:border-amber-400 outline-none"
              min={1}
              max={1000}
            />
          </label>
        )}

          <button
            onClick={() => setShowGameModeModal(true)}
            disabled={loading || !!waitingGameId}
            className="border-b-4 border-amber-700 px-8 py-3 rounded-xl font-bold text-black bg-amber-500 hover:bg-amber-400 shadow-[0_0_18px_rgba(251,191,36,0.35)] active:translate-y-[2px] transition"
          >
            {loading ? t("neonFlush.loading") : t("neonFlush.startGame")}
          </button>
          <button
            onClick={joinOnlineGame}
            disabled={loading || !!waitingGameId}
            className="border-b-4 border-cyan-700 mt-4 px-8 py-3 rounded-xl font-bold text-black bg-cyan-500 hover:bg-cyan-400 shadow-[0_0_18px_rgba(34,211,238,0.35)] active:translate-y-[2px] transition"
          >
            {loading ? t("neonFlush.searching") : t("neonFlush.joinGame")}
          </button>
          <button
            onClick={() => router.push("/uno/multiplayer")}
            className="mt-4 px-8 py-3 rounded-full font-bold text-[#001933] bg-green-300 hover:bg-green-200"
          >
            {t("neonFlush.tableMode")}
          </button>

          {waitingGameId && (
            <button
              onClick={cancelWaitingOnlineGame}
              disabled={isCancellingWaitingGame}
              className="mt-3 bg-red-600 hover:bg-red-500 text-white px-8 py-2 rounded-full font-bold"
            >
              {isCancellingWaitingGame ? t("neonFlush.cancelling") : t("neonFlush.cancelWaiting")}
            </button>
          )}

          <div className="mt-6 w-full max-w-md rounded-2xl p-4 border border-cyan-700/30 bg-slate-900/80">
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-lg font-bold text-cyan-300">{t("neonFlush.onlineGames")}</h3>
              <button
                onClick={fetchAvailableGames}
                disabled={isLoadingAvailableGames}
                className="bg-cyan-500 text-black px-3 py-1 rounded-md text-sm font-semibold hover:bg-cyan-400 transition"
              >
                {isLoadingAvailableGames ? "..." : <span className="inline-flex items-center gap-1.5"><IconRefresh size={14} /> {t("neonFlush.refresh")}</span>}
              </button>
            </div>
            {isLoadingAvailableGames ? (
              <p className="text-sm text-gray-200">{t("neonFlush.loadingGames")}</p>
            ) : availableGames.length === 0 ? (
              <p className="text-sm text-gray-200">{t("neonFlush.noGames")}</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {availableGames.slice(0, 6).map((onlineGame) => (
                  <li
                    key={onlineGame.id}
                    className="flex justify-between items-center bg-black/30 border border-cyan-700/30 hover:border-cyan-500/50 rounded-lg px-3 py-2 transition"
                  >
                    <span>
                      {onlineGame.hostName} • {t("neonFlush.wager")}: <span className="text-yellow-300 font-semibold">{onlineGame.betAmount}</span>
                    </span>
                    <button
                      onClick={() => joinSpecificOnlineGame(onlineGame.id)}
                      disabled={!onlineGame.canAfford || loading || !!waitingGameId}
                      className={`px-3 py-1 rounded-md font-semibold ${onlineGame.canAfford && !waitingGameId ? "bg-cyan-500 text-black hover:bg-cyan-400" : "bg-gray-600 text-gray-200 cursor-not-allowed"}`}
                    >
                      {onlineGame.canAfford ? t("neonFlush.join") : t("neonFlush.insufficient")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {showGameModeModal && (
            <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
              <div className="bg-[#08142f] text-white border border-[#00e5ff]/40 rounded-2xl p-6 w-full max-w-sm">
                <h3 className="text-xl font-bold mb-4 text-center text-[#FFD700]">
                  {t("neonFlush.chooseMode")}
                </h3>
                <div className="flex flex-col gap-3">
                  <button
                    onClick={() => {
                      setShowGameModeModal(false);
                      initializeGame();
                    }}
                    className="border-b-4 border-amber-700 px-4 py-2 rounded-lg font-bold bg-amber-500 text-black hover:bg-amber-400 transition"
                  >
                    {t("neonFlush.playVsAi")}
                  </button>
                  <button
                    onClick={createOnlineGame}
                    disabled={!!waitingGameId}
                    className="border-b-4 border-cyan-700 px-4 py-2 rounded-lg font-bold bg-cyan-500 text-black hover:bg-cyan-400 transition"
                  >
                    {t("neonFlush.createOnline")}
                  </button>
                  <button
                    onClick={() => setShowGameModeModal(false)}
                    className="bg-red-600 text-white px-4 py-2 rounded-lg font-semibold"
                  >
                    {t("neonFlush.cancel")}
                  </button>
                </div>
              </div>
            </div>
          )}

          {message && <p className="mt-6 text-yellow-300 text-lg font-medium">{message}</p>}
        </div>
      ) : (
        <div className="mb-16 flex w-full max-w-6xl items-stretch gap-4">
          {/* Board — compact, shifted left so the history panel has room */}
          <div className="relative flex min-w-0 flex-1 flex-col items-center justify-between overflow-hidden rounded-3xl border-2 border-[#00e5ff]/30 bg-gradient-to-br from-[#001a33] via-[#000d1f] to-[#000814] p-3 shadow-[0_0_35px_rgba(0,229,255,0.15)] sm:p-4">
            {/* Opponent / AI hand — overlapping backs to save height */}
            <div className="w-full">
              <div className="mb-1.5 flex items-center justify-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#9dd8ff]/80">
                {gameMode === "online" ? <IconUser size={13} /> : <IconRobot size={13} />}
                {gameMode === "online" ? t("neonFlush.opponentHand") : t("neonFlush.aiHand")}
                {!isPlayerTurn && gameMode === "ai" && (
                  <IconRobot size={13} className="animate-spin" style={{ animationDuration: "1s" }} />
                )}
              </div>
              <div className="flex justify-center">
                {Array(aiHandCount)
                  .fill(0)
                  .map((_, i) => (
                    <div key={i} className="-ml-5 first:ml-0">
                      <UnoBack />
                    </div>
                  ))}
                {aiHandCount === 0 && <div className="h-20 w-14" />}
              </div>
            </div>

            {showColorPicker && (
              <div className="absolute inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
                <div className="rounded-2xl border-2 border-[#00e5ff]/50 bg-[#040d24] p-6 shadow-[0_0_35px_rgba(0,229,255,0.35)] text-white flex flex-col items-center gap-5">
                  <h2 className="mb-1 flex items-center gap-2 text-xl font-black uppercase tracking-widest text-[#00e5ff]">
                    {t("neonFlush.chooseColor")} <IconPalette size={20} />
                  </h2>
                  <div className="grid grid-cols-2 gap-4">
                    {[
                      { color: "red", labelKey: "neonFlush.colorPink" },
                      { color: "blue", labelKey: "neonFlush.colorCyan" },
                      { color: "green", labelKey: "neonFlush.colorMint" },
                      { color: "yellow", labelKey: "neonFlush.colorGold" },
                    ].map(({ color, labelKey }) => (
                      <button
                        key={color}
                        onClick={() => {
                          setShowColorPicker(false);
                          sendPlayCard(pendingCard, color);
                        }}
                        className="h-20 w-20 rounded-xl text-sm font-black uppercase text-[#031026] transition-transform hover:scale-105"
                        style={{
                          backgroundColor: UNO_PALETTE[color],
                          boxShadow: `0 0 16px ${UNO_PALETTE[color]}66`,
                        }}
                      >
                        {t(labelKey)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Center row: current color + card + history scrub */}
            <div className="my-3 flex items-center justify-center gap-4 sm:gap-6">
              <div className="flex flex-col items-center gap-1 rounded-xl border border-[#00e5ff]/30 bg-[#040d24]/80 px-3 py-2">
                <span className="text-[9px] font-bold uppercase tracking-widest text-[#9dd8ff]/70">
                  {t("neonFlush.currentColor")}
                </span>
                <span className="flex items-center gap-1.5 text-sm font-black uppercase">
                  <span
                    className="inline-block h-3.5 w-3.5 rounded-full"
                    style={{ backgroundColor: currentColorHex, boxShadow: `0 0 10px ${currentColorHex}` }}
                  />
                  <span style={{ color: currentColorHex }}>{currentColorLabel}</span>
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

            {/* Player hand */}
            <div
              className={`flex flex-wrap justify-center gap-1.5 rounded-2xl p-2 ${isPlayerTurn ? "ring-2 ring-[#00e5ff]/50 shadow-[0_0_18px_rgba(0,229,255,0.25)]" : ""}`}
            >
              {playerHand.map((card, i) => (
                <UnoCard
                  key={i}
                  color={card.color}
                  value={card.value}
                  onClick={() => playCard(card)}
                />
              ))}
            </div>

            {/* Action buttons — neon cyberpunk */}
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
          </div>

          {/* Move history — right panel */}
          <aside className="hidden w-60 shrink-0 flex-col rounded-3xl border border-[#00e5ff]/30 bg-[#040d24]/70 p-3 backdrop-blur md:flex">
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
                    key={i}
                    onClick={() => setHistoryIndex(i === turnHistory.length - 1 ? null : i)}
                    className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs transition-all ${
                      isCurrent
                        ? "border-[#00e5ff]/70 bg-[#00e5ff]/10 shadow-[0_0_10px_rgba(0,229,255,0.15)]"
                        : "border-[#00e5ff]/20 bg-black/30 hover:border-[#00e5ff]/50"
                    }`}
                  >
                    <span
                      className="inline-block h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: historyColor(card), boxShadow: `0 0 8px ${historyColor(card)}` }}
                    />
                    <span className="truncate font-bold uppercase tracking-wide">{historyLabel(card)}</span>
                    <span className="ml-auto text-[10px] text-[#9dd8ff]/60">#{i + 1}</span>
                  </button>
                );
              })}
            </div>
          </aside>
        </div>
      )}
      </CreatorResponsiveLayout>
      </CreatorModeHost>
      <Footer />
    </div>
  );
}
