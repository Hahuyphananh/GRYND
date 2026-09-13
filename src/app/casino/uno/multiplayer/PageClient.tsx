"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { usePostHog } from "posthog-js/react";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay and auto-starts when the real hand begins, auto-stops
// once the end popup shows. The create/join table lobby stays OUTSIDE so
// nothing is recorded during matchmaking. No gameplay logic touched.
import CreatorModeHost from "../../../../components/creator-mode/CreatorModeHost";
import {
  CreatorView,
  CreatorModeShell,
  ShellHeader,
  ShellMain,
  ShellAside,
} from "../../../../components/creator-mode/CreatorModeLayout";
import UnoCard, { UNO_PALETTE } from "../../../../components/UnoCard";
import UnoBack from "../../../../components/UnoBack";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import IconAvatar from "../../../../components/IconAvatar";
import NavigationBar from "../../../../components/navigation-bar";
import Footer from "../../../../components/Footer";
import { useSocket } from "../../../../context/SocketProvider";
import EmotePicker, { EmoteBubble } from "../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../hooks/useGameEmotes";
import useGamePresence from "../../../../hooks/useGamePresence";
import { turnBanner as turnBannerAnim } from "../../../../lib/animations";
import { playCardPlace, playTurnSwitch, playVictory } from "../../../../lib/gameAudio";
import ReportModal from "../../../../components/ReportModal";
import {
  IconRobot,
  IconUser,
  IconFlag,
  IconHistory,
} from "@tabler/icons-react";
import { useTranslation } from "../../../../hooks/useTranslation";

const UNO_MULTI_SEAT_POSITIONS = [
  { left: "50%", top: "15%" },
  { left: "78%", top: "30%" },
  { left: "78%", top: "68%" },
  { left: "50%", top: "84%" },
  { left: "22%", top: "68%" },
  { left: "22%", top: "30%" },
];

export default function UnoMultiplayerPage() {
  const router = useRouter();
  const { socket } = useSocket();
  const posthog = usePostHog();
  const { t } = useTranslation();
  const roomSyncRef = useRef<NodeJS.Timeout | null>(null);
  const replayClientIdRef = useRef(Math.random().toString(36).slice(2));

  const [game, setGame] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [tokens, setTokens] = useState<{ balance: number } | null>(null);
  const [unoMultiSettings, setUnoMultiSettings] = useState({
    gameName: "Neon Flush Table",
    visibility: "private",
    betAmount: 100,
    maxPlayers: 4,
    startingCards: 7,
    turnTimeSeconds: 30,
  });
  const [unoMultiTableCode, setUnoMultiTableCode] = useState("");
  const [unoMultiPublicGames, setUnoMultiPublicGames] = useState<any[]>([]);
  const [unoMultiPlayers, setUnoMultiPlayers] = useState<any[]>([]);
  const [unoMultiHostId, setUnoMultiHostId] = useState<number | null>(null);
  const [unoMultiMyId, setUnoMultiMyId] = useState<number | null>(null);
  const [unoMultiStarted, setUnoMultiStarted] = useState(false);
  const [unoMultiMessage, setUnoMultiMessage] = useState("");
  const [unoMultiJoinCode, setUnoMultiJoinCode] = useState("");
  const [unoMultiSkipRound, setUnoMultiSkipRound] = useState(false);
  const [unoMultiBackendMode, setUnoMultiBackendMode] = useState<string | null>(null);
  const [unoMultiHandCounts, setUnoMultiHandCounts] = useState<any[]>([]);
  const [unoMultiTurnPlayerId, setUnoMultiTurnPlayerId] = useState<any>(null);
  const [showSeatPopup, setShowSeatPopup] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);

  const [playerHand, setPlayerHand] = useState<any[]>([]);
  const [topCard, setTopCard] = useState<any>(null);
  const [turnHistory, setTurnHistory] = useState<any[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [isPlayerTurn, setIsPlayerTurn] = useState(false);
  const [message, setMessage] = useState("");

  const [showColorPicker, setShowColorPicker] = useState(false);
  const [pendingCard, setPendingCard] = useState<any>(null);
  const [selectedSeat, setSelectedSeat] = useState<number | null>(null);
  const [endPopup, setEndPopup] = useState<{
    result: "win" | "loss";
    reason: string;
    openedAt: number;
  } | null>(null);
  // Pot captured from the finished payload — the winner's payout
  // mirrors the server's settleWinner math (pot × 95%), so the net
  // token delta is only shown when the pot is known.
  const [endPot, setEndPot] = useState<number | null>(null);
  const [replayRequested, setReplayRequested] = useState(false);
  const [opponentReplayRequested, setOpponentReplayRequested] = useState(false);
  const [returnChosen, setReturnChosen] = useState(false);
  const [replaySecondsLeft, setReplaySecondsLeft] = useState(15);
  const [turnBanner, setTurnBanner] = useState<string | null>(null);
  const prevIsPlayerTurnRef = useRef<boolean | null>(null);

  const openEndPopup = (
    result: "win" | "loss",
    reason = "finished",
    pot: number | null = null,
  ) => {
    setEndPopup({ result, reason, openedAt: Date.now() });
    setEndPot(pot);
    setReplayRequested(false);
    setOpponentReplayRequested(false);
    setReturnChosen(false);
    setReplaySecondsLeft(15);
    if (result === "win") { playVictory(); }
    posthog?.capture("neon_flush_table_game_ended", {
      result,
      reason,
      bet_amount: unoMultiSettings.betAmount,
      game_id: game?.id,
    });
  };

  const closeToUnoLobby = () => {
    setReturnChosen(true);
    if (socket && game?.id) {
      socket.emit("room_event", {
        roomId: `uno:multi:end:${game.id}`,
        event: "uno:multi:end:return",
        payload: { gameId: game.id, clientId: replayClientIdRef.current },
      });
    }
    void resetUnoMultiplayerLobby();
  };

  const requestReplay = () => {
    if (!endPopup || returnChosen) return;
    setReplayRequested(true);
    if (socket && game?.id) {
      socket.emit("room_event", {
        roomId: `uno:multi:end:${game.id}`,
        event: "uno:multi:end:replay",
        payload: { gameId: game.id, clientId: replayClientIdRef.current },
      });
    }
  };

  useGamePresence({
    gameKey: "uno",
    gameId: Number(game?.id),
    enabled: Boolean(game?.id),
  });

  useEffect(() => {
    if (!socket || !game?.id || !endPopup) return;
    const roomId = `uno:multi:end:${game.id}`;
    const handleReplay = (payload: any) => {
      if (payload?.gameId !== game.id || payload?.clientId === replayClientIdRef.current) return;
      setOpponentReplayRequested(true);
    };
    const handleReturn = (payload: any) => {
      if (payload?.gameId !== game.id || payload?.clientId === replayClientIdRef.current) return;
      setReturnChosen(true);
    };
    socket.emit("join_room", { roomId });
    socket.on("uno:multi:end:replay", handleReplay);
    socket.on("uno:multi:end:return", handleReturn);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("uno:multi:end:replay", handleReplay);
      socket.off("uno:multi:end:return", handleReturn);
    };
  }, [socket, game?.id, endPopup]);

  useEffect(() => {
    if (!endPopup) return;
    const deadline = endPopup.openedAt + 15000;
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setReplaySecondsLeft(remaining);
      if (remaining <= 0) {
        clearInterval(id);
        void resetUnoMultiplayerLobby();
      }
    }, 250);
    return () => clearInterval(id);
  }, [endPopup]);

  useEffect(() => {
    if (replayRequested && opponentReplayRequested) {
      void resetUnoMultiplayerLobby();
      setUnoMultiMessage("Replay accepted. Start another UNO table from the lobby.");
    }
  }, [replayRequested, opponentReplayRequested]);

  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const res = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        const data = await res.json();
        if (data.success) setTokens({ balance: Number(data.data.balance) });
      } catch (error) {
        console.error("Unable to load tokens", error);
      }
    };
    fetchTokens();
  }, []);

  const fetchUnoMultiplayerPublicGames = async () => {
    try {
      const res = await fetch("/api/uno/multiplayer", {
        method: "GET",
        credentials: "include",
      });
      const data = await res.json();
      setUnoMultiPublicGames(data.success ? data.rooms || [] : []);
    } catch (error) {
      console.error("Unable to fetch UNO multiplayer public games", error);
      setUnoMultiPublicGames([]);
    }
  };

  useEffect(() => {
    fetchUnoMultiplayerPublicGames();
  }, []);

  // Turn banner animation
  useEffect(() => {
    if (prevIsPlayerTurnRef.current !== null && prevIsPlayerTurnRef.current !== isPlayerTurn && game) {
      setTurnBanner(isPlayerTurn ? "Your Turn" : "Opponent's Turn");
      playTurnSwitch(isPlayerTurn);
      setTimeout(() => setTurnBanner(null), 1800);
    }
    prevIsPlayerTurnRef.current = isPlayerTurn;
  }, [isPlayerTurn, game]);

  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:uno";
    const handleLobbyUpdate = () => fetchUnoMultiplayerPublicGames();
    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", handleLobbyUpdate);

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", handleLobbyUpdate);
    };
  }, [socket]);

  const hydrateUnoTableGame = (tableGame: any, fullSyncData: any = null) => {
    if (!tableGame?.id) return;
    setGame({ id: tableGame.id, role: tableGame.role });
    setUnoMultiBackendMode(tableGame.mode || "table");
    setUnoMultiStarted(true);
    setTopCard(tableGame.topCard || null);
    setGame((prev: any) => ({
      ...prev,
      currentColor: tableGame.currentColor,
    }));
    setUnoMultiHandCounts(Array.isArray(tableGame.handCounts) ? tableGame.handCounts : []);
    setUnoMultiTurnPlayerId(tableGame.turnPlayerId || null);
    setTurnHistory(tableGame.topCard ? [tableGame.topCard] : []);
    setHistoryIndex(null);
    setPlayerHand(Array.isArray(tableGame.playerHand) ? tableGame.playerHand : []);
    const myTurn = tableGame.turnPlayerId === tableGame.role;
    setIsPlayerTurn(Boolean(myTurn));
    setMessage(myTurn ? "Your turn" : "Opponent turn...");

    // Handle game end from full sync data (if provided)
    if (fullSyncData) {
      if (fullSyncData.status === "finished" && !endPopup) {
        const youWon = fullSyncData.data?.winner === fullSyncData.data?.role;
        setMessage(youWon ? "You won the match!" : "You lost the match.");
        openEndPopup(youWon ? "win" : "loss", "finished", fullSyncData.data?.pot);
      } else if (fullSyncData.shouldReturnToLobby || !fullSyncData.data?.role) {
        setMessage("Game over.");
        openEndPopup("loss", "finished", fullSyncData.data?.pot);
      }
    }
  };

  // Single unified polling for both room state (lobby) and active game
  // Replaces the dual-interval approach (roomSyncRef + game sync) to eliminate
  // race conditions and redundant fetches.
  useEffect(() => {
    if (!unoMultiTableCode) return;

    let currentInterval: NodeJS.Timeout | null = null;
    let lastKnownStarted = false;

    const poll = async () => {
      try {
        // Single endpoint returns both room + active game (if started)
        const res = await fetch(`/api/uno/multiplayer?code=${unoMultiTableCode}`, {
          method: "GET",
          credentials: "include",
        });
        const data = await res.json();
        if (!data.success) return;

        // Update room state (players, settings, host)
        setUnoMultiPlayers(data.room.players || []);
        setUnoMultiSettings((prev) => ({
          ...prev,
          ...(data.room.settings || {}),
        }));
        setUnoMultiHostId(data.room.players.find((p: any) => p.isHost)?.id ?? null);

        // Keep myId stable - prefer userId match, fallback to previous ID
        const me =
          data.room.players.find((p: any) => p.userId === data.currentUserId) ||
          data.room.players.find((p: any) => p.id === unoMultiMyId);
        if (me) setUnoMultiMyId(me.id);

        const roomStarted = Boolean(data.room.started);

        // If room just transitioned to started, or we're already in-game
        if (roomStarted || game?.id) {
          setUnoMultiStarted(true);
          // Also fetch active game state if we don't have it or game just started
          if (!game?.id || roomStarted !== lastKnownStarted) {
            const syncRes = await fetch("/api/uno/multiplayer", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                action: "sync-active-game",
                code: unoMultiTableCode,
              }),
            });
            const syncData = await syncRes.json();
            if (syncData.success && syncData.game) {
              hydrateUnoTableGame(syncData.game, syncData);
            }
          }
        }

        lastKnownStarted = roomStarted;
      } catch (error) {
        console.error("Unable to sync UNO multiplayer room/game", error);
      }
    };

    // Initial immediate poll
    poll();

    // Poll every 2s (covers both lobby updates and in-game state)
    currentInterval = setInterval(poll, 2000);

    return () => {
      if (currentInterval) clearInterval(currentInterval);
    };
  }, [unoMultiTableCode, game?.id]);

  useEffect(() => {
    if (!unoMultiTableCode) return;
    const syncSkip = async () => {
      try {
        await fetch("/api/uno/multiplayer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            action: "toggle-skip",
            code: unoMultiTableCode,
            skipNextRound: unoMultiSkipRound,
          }),
        });
      } catch (error) {
        console.error("Unable to toggle skip round", error);
      }
    };
    syncSkip();
  }, [unoMultiSkipRound, unoMultiTableCode]);

  const createUnoMultiplayerTable = async () => {
    try {
      const res = await fetch("/api/uno/multiplayer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "create", settings: unoMultiSettings }),
      });
      const data = await res.json();
      if (!data.success) {
        setUnoMultiMessage(data.error || "Unable to create table.");
        return;
      }

      setUnoMultiTableCode(data.room.code);
      setUnoMultiPlayers(data.room.players || []);
      setUnoMultiHostId(data.room.players.find((p: any) => p.isHost)?.id ?? null);
      const myPlayer = data.room.players.find((p: any) => p.userId === data.currentUserId);

      setUnoMultiMyId(myPlayer?.id ?? null);
      setShowSeatPopup(false);

      setUnoMultiStarted(Boolean(data.room.started));
      setUnoMultiMessage("Table created. Add players or AI, then start.");
      fetchUnoMultiplayerPublicGames();
    } catch (error) {
      console.error("Unable to create multiplayer table", error);
    }
  };

const joinUnoPublicTable = async (tableCode: string) => {
    try {
      const res = await fetch("/api/uno/multiplayer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "join", code: tableCode }),
      });
      const data = await res.json();
      if (!data.success) {
        setUnoMultiMessage(data.error || "Unable to join table.");
        return;
      }

      // Use joinedPlayerId from API response (player was added to room during join)
      const joinedPlayerId = data.joinedPlayerId;
      const myPlayer = joinedPlayerId
        ? data.room.players.find((p) => p.id === joinedPlayerId)
        : data.room.players.find((p) => p.userId === data.currentUserId);

      setUnoMultiTableCode(data.room.code);
      setUnoMultiPlayers(data.room.players || []);
      setUnoMultiHostId(data.room.players.find((p) => p.isHost)?.id ?? null);
      setUnoMultiMyId(myPlayer?.id ?? null);
      setUnoMultiStarted(Boolean(data.room.started));
      setUnoMultiSettings((prev) => ({
        ...prev,
        ...(data.room.settings || {}),
      }));
      setUnoMultiMessage(`Joined table ${data.room.code}. Choose a seat to play.`);
      setShowSeatPopup(true);
      fetchUnoMultiplayerPublicGames();
    } catch (error) {
      console.error("Unable to join multiplayer table", error);
    }
  };

  const joinUnoPrivateTable = async () => {
    if (!unoMultiJoinCode.trim()) {
      setUnoMultiMessage("Enter a private code.");
      return;
    }
    joinUnoPublicTable(unoMultiJoinCode.trim().toUpperCase());
  };

  const isHost = useMemo(() => {
    const me = unoMultiPlayers.find((p) => p.id === unoMultiMyId);
    if (me?.isHost) return true;
    return Boolean(unoMultiMyId && unoMultiHostId && unoMultiMyId === unoMultiHostId);
  }, [unoMultiPlayers, unoMultiMyId, unoMultiHostId]);

  const mePlayer = useMemo(
    () => unoMultiPlayers.find((p) => p.id === unoMultiMyId),
    [unoMultiPlayers, unoMultiMyId]
  );

  const meSeated = mePlayer?.seatIndex !== null && mePlayer?.seatIndex !== undefined;

const sitAsHuman = async (seatIndex: number) => {
    // Optimistic update - immediately show as seated
    setUnoMultiPlayers((prev) =>
      prev.map((p) =>
        p.id === unoMultiMyId ? { ...p, seatIndex } : p
      )
    );
    setShowSeatPopup(false);

    try {
      const res = await fetch("/api/uno/multiplayer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "sit-human",
          code: unoMultiTableCode,
          seatIndex,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setUnoMultiMessage(data.error || "Unable to sit.");
        // Revert optimistic update on error
        setUnoMultiPlayers((prev) =>
          prev.map((p) =>
            p.id === unoMultiMyId ? { ...p, seatIndex: null } : p
          )
        );
        return;
      }
      setUnoMultiPlayers(data.room.players || []);
      const me = data.room.players.find((p) => p.userId === data.currentUserId);
      if (me) setUnoMultiMyId(me.id);
    } catch (error) {
      console.error("Unable to sit as human", error);
      setUnoMultiMessage("Connection error. Please try again.");
      // Revert optimistic update
      setUnoMultiPlayers((prev) =>
        prev.map((p) =>
          p.id === unoMultiMyId ? { ...p, seatIndex: null } : p
        )
      );
    }
  };

  const addUnoMultiAiToSeat = async (seatIndex: number) => {
    if (!isHost || unoMultiStarted || !unoMultiTableCode) return;
    try {
      const res = await fetch("/api/uno/multiplayer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "add-ai",
          code: unoMultiTableCode,
          seatIndex,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setUnoMultiMessage(data.error || "Unable to add AI.");
        return;
      }
      setUnoMultiPlayers(data.room.players || []);
      setUnoMultiHostId(data.room.players.find((p: any) => p.isHost)?.id ?? null);
      setShowSeatPopup(false);
      setSelectedSeat(null);
    } catch (error) {
      console.error("Unable to add AI", error);
    }
  };

  const startUnoMultiplayerGame = async () => {
    if (unoMultiPlayers.length < 2) {
      setUnoMultiMessage("Need at least 2 players.");
      return;
    }

    try {
      const res = await fetch("/api/uno/multiplayer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "start", code: unoMultiTableCode }),
      });
      const data = await res.json();
      if (!data.success) {
        setUnoMultiMessage(data.error || "Unable to start.");
        return;
      }
      setUnoMultiStarted(true);
      setUnoMultiPlayers(data.room.players || []);
      setUnoMultiHostId(data.room.players.find((p: any) => p.isHost)?.id ?? null);
      if (data.game) hydrateUnoTableGame(data.game);
      if (typeof data.game?.newBalance !== "undefined") {
        setTokens({ balance: Number(data.game.newBalance) });
      }
      setUnoMultiMessage("Game started.");
      posthog?.capture("neon_flush_table_game_started", {
        bet_amount: unoMultiSettings.betAmount,
        player_count: unoMultiPlayers.length,
        game_id: data.game?.id,
      });
      fetchUnoMultiplayerPublicGames();
    } catch (error) {
      console.error("Unable to start table game", error);
    }
  };

  const resetUnoMultiplayerLobby = async () => {
    if (unoMultiTableCode) {
      try {
        await fetch("/api/uno/multiplayer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ action: "leave", code: unoMultiTableCode }),
        });
      } catch (error) {
        console.error("Unable to leave table", error);
      }
    }

    setGame(null);
    setUnoMultiTableCode("");
    setUnoMultiPlayers([]);
    setUnoMultiHostId(null);
    setUnoMultiMyId(null);
    setUnoMultiStarted(false);
    setUnoMultiMessage("");
    setUnoMultiBackendMode(null);
    setUnoMultiSkipRound(false);
    setUnoMultiHandCounts([]);
    setUnoMultiTurnPlayerId(null);
    setPlayerHand([]);
    setTopCard(null);
    setTurnHistory([]);
    setHistoryIndex(null);
    setIsPlayerTurn(false);
    setMessage("");
    setEndPopup(null);
    setReplayRequested(false);
    setOpponentReplayRequested(false);
    setReturnChosen(false);
    fetchUnoMultiplayerPublicGames();
  };

  const sendPlayCard = async (card: any, chosenColor: string | null = null) => {
    if (!isPlayerTurn || loading || historyIndex !== null) return;

    const isWild =
      card.value.toLowerCase() === "wild" || card.value.toLowerCase() === "wild draw four";

    if (isWild && !chosenColor) {
      setPendingCard(card);
      setShowColorPicker(true);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/uno/multiplayer/play-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: unoMultiTableCode, card, chosenColor }),
      });
      const data = await res.json();

      if (!data.success) {
        setMessage(data.error || "Move rejected.");
        return;
      }
      if (data.status === "finished" || data.shouldReturnToLobby || !data.data?.role) {
        const youWon = data.data?.winner === data.data?.role;
        setMessage(youWon ? "You won the match!" : "You lost the match.");
        openEndPopup(youWon ? "win" : "loss", "finished", data.data?.pot);
        return;
      }

      setPlayerHand(data.data.playerHand || []);
      setTopCard(data.data.topCard || null);
      setTurnHistory((prev) => [...prev, data.data.topCard]);
      setHistoryIndex(null);
      setUnoMultiHandCounts(Array.isArray(data.data.handCounts) ? data.data.handCounts : []);
      setUnoMultiTurnPlayerId(data.data.turnPlayerId || null);
      setIsPlayerTurn(data.data.turnPlayerId === data.data.role);
      setMessage(data.data.message || "Move played.");
      setPendingCard(null);
      setShowColorPicker(false);
      playCardPlace();
      posthog?.capture("neon_flush_table_card_played", {
        color: card.color,
        value: card.value,
        game_id: game?.id,
        cards_left: data.data.playerHand?.length ?? 0,
      });
    } finally {
      setLoading(false);
    }
  };

  const drawCard = async () => {
    if (!isPlayerTurn || loading || historyIndex !== null) return;
    setLoading(true);

    try {
      const res = await fetch("/api/uno/multiplayer/draw-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: unoMultiTableCode }),
      });
      const data = await res.json();
      if (!data.success) {
        setMessage(data.error || "Unable to draw.");
        return;
      }
      if (data.status === "finished" || data.shouldReturnToLobby || !data.data?.role) {
        const youWon = data.data?.winner === data.data?.role;
        setMessage(youWon ? "You won the match!" : "You lost the match.");
        openEndPopup(youWon ? "win" : "loss", "finished", data.data?.pot);
        return;
      }

      setPlayerHand(data.data.playerHand || []);
      setTopCard(data.data.topCard || null);
      setTurnHistory((prev) => [...prev, data.data.topCard]);
      setHistoryIndex(null);
      setUnoMultiHandCounts(Array.isArray(data.data.handCounts) ? data.data.handCounts : []);
      setUnoMultiTurnPlayerId(data.data.turnPlayerId || null);
      setIsPlayerTurn(data.data.turnPlayerId === data.data.role);
      setMessage(data.data.message || "Card drawn.");
      posthog?.capture("neon_flush_table_card_drawn", {
        game_id: game?.id,
        hand_count: data.data.playerHand?.length ?? 0,
      });
    } finally {
      setLoading(false);
    }
  };

  const resignGame = async () => {
    if (!game?.id || loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/uno/multiplayer/resign-and-leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: unoMultiTableCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || "Unable to resign.");
        return;
      }
      if (typeof data.newBalance !== "undefined") {
        setTokens({ balance: Number(data.newBalance) });
      }
      setMessage("You resigned.");
      openEndPopup("loss", "resigned");
    } finally {
      setLoading(false);
    }
  };

  const displayedCard = historyIndex === null ? topCard : turnHistory[historyIndex];
  const currentColorName = (game?.currentColor || topCard?.color) as string | undefined;
  const currentColorHex =
    (currentColorName && UNO_PALETTE[currentColorName as keyof typeof UNO_PALETTE]) ||
    "#38FCFC";
  const COLOR_NAME_KEYS: Record<string, string> = {
    red: "neonFlush.colorPink",
    blue: "neonFlush.colorCyan",
    green: "neonFlush.colorMint",
    yellow: "neonFlush.colorGold",
  };
  const currentColorLabel = t(
    COLOR_NAME_KEYS[String(currentColorName || "").toLowerCase()] || "neonFlush.colorCyan",
  );
  const historyColor = (card: any) =>
    UNO_PALETTE[String(card?.color || "").toLowerCase() as keyof typeof UNO_PALETTE] || "#38FCFC";
  const historyLabel = (card: any) => {
    const v = String(card?.value || "").toLowerCase().replace(/\s/g, "");
    if (/^\d+$/.test(v)) return String(card.value);
    if (v === "drawtwo" || v === "+2") return "+2";
    if (v === "wilddrawfour" || v === "+4") return "+4";
    if (v === "wild") return "HACK";
    if (v === "skip") return "GLITCH";
    if (v === "reverse") return "LOOP";
    return String(card.value || "");
  };
  const orderedOpponents = useMemo(
    () =>
      unoMultiHandCounts
        .filter((entry) => entry.playerId !== game?.role)
        .sort((a, b) => a.seatIndex - b.seatIndex),
    [unoMultiHandCounts, game?.role]
  );

  const currentPlayer = unoMultiPlayers.find((p) => p.id === unoMultiTurnPlayerId);

  const isAiThinking = currentPlayer?.type === "ai" && !loading;

  // Find first human opponent (for reporting)
  const humanOpponent = useMemo(() => {
    if (!game) return null;
    return unoMultiPlayers.find(
      (p) => p.type !== "ai" && p.userId && p.userId !== (game as any)?.currentUserId
    ) || null;
  }, [unoMultiPlayers, game]);

  // Emotes — dedicated per-table room for human opponents.
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: game?.id ? `uno:multi:emote:${game.id}` : null,
    eventName: "uno:emote",
    selfId: (game as any)?.currentUserId ?? null,
  });

  // ── Result screen — shared PvpResultScreen (UX plan P3-3) ───────
  // Rendered as a fixed overlay when the table ends (win/loss). The
  // old bespoke end popup is deleted. Every number comes from real
  // data: the table's `betAmount` (server settings) + the finished
  // payload's `pot`; the winner payout mirrors the server's
  // settleWinner math (pot × 95%). The tokens row is hidden when the
  // pot wasn't captured — nothing is invented.
  const renderResult = () => {
    if (!endPopup) return null;
    const won = endPopup.result === "win";
    const bet = Number(unoMultiSettings.betAmount || 0);
    const pot = Number(endPot || 0);
    // Server settlement (settleWinner): the winner is credited
    // pot × (100% − 5% house edge); their own bet was part of the
    // pot, so the net change is payout − bet; losers forfeit their
    // bet.
    const payout = pot > 0 ? Number((pot * 0.95).toFixed(2)) : null;
    const tokenDelta =
      payout !== null && bet > 0
        ? won
          ? payout - bet
          : -bet
        : null;

    const headline = won
      ? "You cleared your hand first"
      : endPopup.reason === "resigned"
        ? "You resigned from the table"
        : "Another player cleared their hand";
    const subline =
      payout !== null && bet > 0
        ? won
          ? `Your ${bet.toFixed(2)} stake back plus ${(payout - bet).toFixed(2)} in winnings.`
          : `You lost your ${bet.toFixed(2)} stake.`
        : undefined;

    return (
      <PvpResultScreen
        open
        compact
        outcome={won ? "win" : "loss"}
        headline={headline}
        subline={subline}
        gameName={unoMultiSettings.gameName || "UNO Table"}
        tokenDelta={tokenDelta}
        summary={[
          { label: "Result", value: won ? "Win" : "Loss" },
          ...(unoMultiPlayers.length > 0
            ? [{ label: "Players", value: String(unoMultiPlayers.length) }]
            : []),
        ]}
        details={[
          ...(unoMultiTableCode
            ? [{ label: "Table code", value: unoMultiTableCode }]
            : []),
          ...(bet > 0
            ? [{ label: "Stake", value: `${bet.toLocaleString()} tokens` }]
            : []),
          ...(payout !== null
            ? [{ label: "Pot", value: `${pot.toLocaleString()} tokens` }]
            : []),
        ]}
        detailsContent={
          <div className="mt-3 text-center">
            <p className="text-xs font-bold uppercase tracking-widest text-yellow-200">
              Replay window: {replaySecondsLeft}s
            </p>
            <p className="mt-1 text-xs text-slate-300">
              {returnChosen
                ? "A player chose the lobby. Replay is disabled."
                : opponentReplayRequested
                  ? "Another player is ready for replay."
                  : "Players must click replay before the timer ends."}
            </p>
          </div>
        }
        playAgain={{ label: "Replay", onClick: requestReplay }}
        onReturnToLobby={closeToUnoLobby}
      />
    );
  };

  // ── Creator-mode layout nodes ─────────────────────────────────────
  // The game content is split into reusable nodes so the normal page
  // (non-creator) renders byte-for-byte the same, while Creator Mode
  // gets a bespoke arrangement: portrait = phone-style (compact header,
  // the table circle filling the middle, controls pinned at the
  // bottom); landscape/square = the table fills the frame height with
  // controls in a right rail.

  // Compact header for the creator frames — title + tokens + the
  // resign/report/lobby actions as inline buttons (the desktop page
  // floats them fixed at the top; inside a recording frame they must
  // live in the shell header instead).
  const creatorHeaderNode = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate text-lg font-bold">{t("neonFlush.tableTitle")}</h1>
        {tokens && (
          <p className="text-yellow-300 text-xs font-semibold">
            {t("neonFlush.tokens")} : {tokens.balance}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {humanOpponent && (
          <button
            onClick={() => setShowReportModal(true)}
            className="rounded-lg border border-red-500/40 bg-red-500/20 px-2.5 py-1.5 text-[11px] font-bold text-red-300 transition-all hover:bg-red-500/30"
          >
            <span className="inline-flex items-center gap-1"><IconFlag size={11} /> Report</span>
          </button>
        )}
        <button
          onClick={resignGame}
          className="rounded-lg border-2 border-[#FF2D9B]/70 bg-[#FF2D9B]/15 px-2.5 py-1.5 font-black uppercase tracking-wider text-[#ff7ac2] text-[11px] shadow-[0_0_14px_rgba(255,45,155,0.3)] transition-all hover:bg-[#FF2D9B]/25"
        >
          {t("neonFlush.resign")}
        </button>
        <button
          onClick={resetUnoMultiplayerLobby}
          className="rounded-lg border-2 border-[#FFD700]/70 bg-[#FFD700]/15 px-2.5 py-1.5 font-black uppercase tracking-wider text-[#FFE066] text-[11px] shadow-[0_0_14px_rgba(255,215,0,0.3)] transition-all hover:bg-[#FFD700]/25"
        >
          {t("neonFlush.lobby")}
        </button>
      </div>
    </div>
  );

  // The round table — deck + current card + seats + emotes.
  const tableCircleInnerNode = (
    <>
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
        <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-[#9dd8ff]/70">
          {t("neonFlush.currentColor")}
        </p>
        <p className="mb-2 flex items-center justify-center gap-1.5 text-sm font-black uppercase">
          <span
            className="inline-block h-3.5 w-3.5 rounded-full"
            style={{
              backgroundColor: currentColorHex,
              boxShadow: `0 0 10px ${currentColorHex}`,
            }}
          />
          <span style={{ color: currentColorHex }}>{currentColorLabel}</span>
        </p>
        <div className="flex gap-3 justify-center">
          <button onClick={drawCard}>
            <UnoBack />
          </button>
          {displayedCard ? (
            <UnoCard
              color={displayedCard.color}
              value={displayedCard.value}
              onClick={() => {}}
              style={{}}
            />
          ) : (
            <div className="w-16 h-24 rounded-lg bg-[#0f172a]/60 border border-white/25" />
          )}
        </div>
      </div>

      {/* Emotes */}
      <div className="mt-2 flex justify-center">
        <EmotePicker
          compact
          hideBubbles
          incomingEmote={incomingEmote}
          myEmote={myEmote}
          onSend={(emote) => sendEmote(emote)}
        />
      </div>

      {UNO_MULTI_SEAT_POSITIONS.map((pos, seatIndex) => {
        const player = unoMultiPlayers.find((p) => p.seatIndex === seatIndex);
        if (!player || seatIndex >= unoMultiSettings.maxPlayers) return null;
        const hand = unoMultiHandCounts.find((h) => h.playerId === player.id);
        return (
          <div
            key={`${player.id}-${seatIndex}`}
            className="absolute"
            style={{
              left: pos.left,
              top: pos.top,
              transform: "translate(-50%, -50%)",
            }}
          >
            <div
              className={`w-32 rounded-xl border px-2 py-2 text-center ${unoMultiTurnPlayerId === player.id ? "border-[#FFD700] bg-[#FFD700]/20 shadow-[0_0_20px_rgba(255,215,0,0.6)]" : "bg-[#08142f] border-[#00e5ff]/35 text-white"}`}
            >
              <p className="text-xs font-bold truncate">
                <span className="relative inline-flex items-center gap-1">
                  {player.type === "ai" ? (
                    <IconRobot size={14} />
                  ) : (
                    <IconAvatar iconKey={player.iconKey} name={player.name} size="h-4 w-4" />
                  )}
                  <span style={player.nameColor ? { color: player.nameColor } : undefined}>
                    {player.name}
                  </span>
                  {(player as any).prestigeBadge && (
                    <span className="ml-0.5 inline-block rounded-full border border-violet-400/70 bg-violet-500/15 px-1 py-px align-middle text-[8px] font-semibold uppercase tracking-wide text-violet-300">
                      {(player as any).prestigeBadge}
                    </span>
                  )}
                  {player.userId === (game as any)?.currentUserId ? (
                    <EmoteBubble emote={myEmote} side="mine" />
                  ) : player.userId === humanOpponent?.userId ? (
                    <EmoteBubble emote={incomingEmote} />
                  ) : null}
                </span>
              </p>
              <p className="text-[11px] opacity-80">{hand?.count ?? 0} cards</p>
            </div>
          </div>
        );
      })}
    </>
  );

  // Color picker overlay (wild card played).
  const colorPickerNode = showColorPicker ? (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="flex flex-col items-center gap-4 rounded-2xl border-2 border-[#00e5ff]/50 bg-[#040d24] p-6 text-white shadow-[0_0_35px_rgba(0,229,255,0.35)]">
        <h2 className="text-xl font-black uppercase tracking-widest text-[#00e5ff]">
          {t("neonFlush.chooseColor")}
        </h2>
        <div className="grid grid-cols-2 gap-3">
          {(["red", "blue", "green", "yellow"] as const).map((color) => (
            <button
              key={color}
              onClick={() => sendPlayCard(pendingCard, color)}
              className="h-20 w-20 rounded-xl text-sm font-black uppercase text-[#031026] transition-transform hover:scale-105"
              style={{
                backgroundColor: UNO_PALETTE[color],
                boxShadow: `0 0 16px ${UNO_PALETTE[color]}66`,
              }}
            >
              {t(COLOR_NAME_KEYS[color])}
            </button>
          ))}
        </div>
      </div>
    </div>
  ) : null;

  // Turn message + draw/flush buttons + my hand.
  const controlsNode = (
    <>
      {/* Turn message */}
      <div className="my-2 text-center text-sm font-semibold text-yellow-200">
        {isPlayerTurn
          ? t("neonFlush.yourTurn")
          : isAiThinking
            ? <span className="inline-flex items-center gap-1"><IconRobot size={14} /> {currentPlayer?.name} {t("neonFlush.isThinking")}</span>
            : t("neonFlush.waitingPlayer")}
      </div>

      {/* Action buttons — neon cyberpunk */}
      <div className="my-3 flex items-center justify-center gap-3">
        <button
          onClick={drawCard}
          disabled={!isPlayerTurn || loading}
          className="rounded-xl border-2 border-[#38fcfc]/80 bg-gradient-to-r from-[#00e5ff] to-[#38fcfc] px-6 py-3 font-black uppercase tracking-wider text-[#031026] shadow-[0_0_18px_rgba(0,229,255,0.5)] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 min-h-[44px] min-w-[140px]"
        >
          {t("neonFlush.drawCard")}
        </button>
        <button
          className="rounded-xl border-2 border-[#FF2D9B]/60 bg-[#FF2D9B]/15 px-6 py-3 font-black uppercase tracking-wider text-[#ff7ac2] shadow-[0_0_14px_rgba(255,45,155,0.25)] opacity-80 transition-all hover:opacity-100 min-h-[44px] min-w-[120px]"
        >
          {t("neonFlush.flush")}
        </button>
      </div>

      {/* Player hand */}
      <div
        className={`flex flex-wrap justify-center gap-1.5 rounded-2xl p-2 ${isPlayerTurn ? "ring-2 ring-[#00e5ff]/50 shadow-[0_0_18px_rgba(0,229,255,0.25)]" : ""}`}
      >
        {playerHand.map((card, index) => (
          <div
            key={`${card.color}-${card.value}-${index}`}
            className="transition-transform hover:-translate-y-2 duration-200"
          >
            <UnoCard
              color={card.color}
              value={card.value}
              onClick={() => sendPlayCard(card)}
              style={{}}
            />
          </div>
        ))}
      </div>
    </>
  );

  // Opponents strip (top of the board in normal view).
  const opponentsStripNode =
    orderedOpponents.length > 0 ? (
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex gap-2 flex-wrap justify-center max-w-[90%]">
        {orderedOpponents.map((entry) => (
          <div
            key={entry.playerId}
            className={`rounded-xl px-2 py-1 border ${unoMultiTurnPlayerId === entry.playerId ? "border-[#FFD700] bg-[#FFD700]/20" : "border-white/25 bg-black/20"}`}
          >
            <p className="flex items-center justify-center gap-1 text-[10px] font-semibold truncate">
              {entry.type === "ai" ? (
                <IconRobot size={10} />
              ) : (
                <IconAvatar iconKey={entry.iconKey} name={entry.name} size="h-3 w-3" />
              )}
              <span className="truncate" style={entry.nameColor ? { color: entry.nameColor } : undefined}>
                {entry.name}
              </span>
            </p>
            <p className="text-[10px] text-center">{entry.count} cards</p>
          </div>
        ))}
      </div>
    ) : null;

  // Move history inner content (shared by the desktop aside and the
  // creator rails).
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
    </>
  );

  // Desktop history aside (normal page) — hidden on small screens.
  const historyNode = (
    <aside className="hidden w-60 shrink-0 flex-col rounded-3xl border border-[#00e5ff]/30 bg-[#040d24]/70 p-3 backdrop-blur md:flex">
      {historyInnerNode}
    </aside>
  );

  // Normal (non-creator) game view — byte-for-byte the original board
  // row (fixed action buttons + table circle + controls + history).
  const normalView = (
    <div className="mb-16 flex w-full max-w-6xl items-stretch gap-4">
      {/* Board — compact, shifted left so the history panel has room */}
      <div className="relative flex min-w-0 flex-1 flex-col justify-between rounded-3xl border-2 border-[#00e5ff]/30 bg-gradient-to-br from-[#001a33] via-[#000d1f] to-[#000814] p-4 shadow-[0_0_35px_rgba(0,229,255,0.15)]">
        <button
          onClick={resignGame}
          className="fixed top-24 right-5 z-50 rounded-lg border-2 border-[#FF2D9B]/70 bg-[#FF2D9B]/15 px-4 py-2 font-black uppercase tracking-wider text-[#ff7ac2] shadow-[0_0_14px_rgba(255,45,155,0.3)] transition-all hover:bg-[#FF2D9B]/25"
        >
          {t("neonFlush.resign")}
        </button>
        {humanOpponent && (
          <button
            onClick={() => setShowReportModal(true)}
            className="fixed top-24 right-32 z-50 rounded-lg border border-red-500/40 bg-red-500/20 px-3 py-2 text-xs font-bold text-red-300 transition-all hover:bg-red-500/30"
          >
            <span className="inline-flex items-center gap-1"><IconFlag size={12} /> Report</span>
          </button>
        )}
        <button
          onClick={resetUnoMultiplayerLobby}
          className="fixed top-24 left-5 z-50 rounded-lg border-2 border-[#FFD700]/70 bg-[#FFD700]/15 px-4 py-2 font-black uppercase tracking-wider text-[#FFE066] shadow-[0_0_14px_rgba(255,215,0,0.3)] transition-all hover:bg-[#FFD700]/25"
        >
          {t("neonFlush.lobby")}
        </button>

        {/* Table circle — shorter than before */}
        <div className="relative mt-1 w-full h-[380px] rounded-full border-8 border-[#0B1226] bg-gradient-to-br from-[#00111f] via-[#000a16] to-[#00060d]">
          {tableCircleInnerNode}
        </div>

        {colorPickerNode}

        {controlsNode}

        {opponentsStripNode}
      </div>

      {historyNode}
    </div>
  );

  // Portrait (9:16) — phone-style: compact header, the table circle
  // filling the frame width (1:1 circle fills 9/16 of height), controls + history pinned at the bottom.
  const portraitContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellHeader className="flex flex-col gap-1.5">
        {creatorHeaderNode}
      </ShellHeader>
      <ShellMain className="flex-col min-h-0 overflow-hidden">
        <div className="flex-1 w-full min-h-0 overflow-hidden relative flex items-center justify-center px-2 py-2">
          <div className="relative w-full aspect-square rounded-full border-8 border-[#0B1226] bg-gradient-to-br from-[#00111f] via-[#000a16] to-[#00060d]" style={{ maxWidth: "100%" }}>
            {tableCircleInnerNode}
            {colorPickerNode}
            {opponentsStripNode}
          </div>
        </div>
      </ShellMain>
      <ShellAside className="space-y-2">
        {controlsNode}
        <div className="flex w-full flex-col rounded-3xl border border-[#00e5ff]/30 bg-[#040d24]/70 p-3 backdrop-blur">
          {historyInnerNode}
        </div>
      </ShellAside>
    </CreatorModeShell>
  );

  // Landscape (16:9) / square (1:1) — table circle fills the frame
  // height, controls + history in a right rail.
  const landscapeContent = (
    <CreatorModeShell className="bg-gradient-to-br from-[#001933] to-[#000d1a]">
      <ShellMain className="overflow-hidden">
        <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 p-4">
          <div className="relative h-full max-h-full w-full rounded-full border-8 border-[#0B1226] bg-gradient-to-br from-[#00111f] via-[#000a16] to-[#00060d]" style={{ aspectRatio: "1 / 1", maxWidth: "min(100%, 100vh)" }}>
            {tableCircleInnerNode}
            {colorPickerNode}
            {opponentsStripNode}
          </div>
        </div>
      </ShellMain>
      <ShellAside className="space-y-2">
        {controlsNode}
        <div className="flex w-full flex-col rounded-3xl border border-[#00e5ff]/30 bg-[#040d24]/70 p-3 backdrop-blur">
          {historyInnerNode}
        </div>
      </ShellAside>
    </CreatorModeShell>
  );

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="bg-gradient-to-br from-[#001933] mt-12 to-[#000d1a] min-h-screen flex flex-col items-center text-white px-4 py-8"
    >
      <NavigationBar currentPath="/casino" />

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

      <h1 className="text-3xl mb-6 font-bold">{t("neonFlush.tableTitle")}</h1>
      {tokens && (
        <p className="text-yellow-300 mb-4 text-lg">
          {t("neonFlush.tokens")} : {tokens.balance}
        </p>
      )}

      {!game ? (
        <div className="w-full max-w-4xl rounded-[2rem] bg-[#0b224f]/85 border-2 border-[#00e5ff]/35 shadow-[0_0_28px_rgba(0,229,255,0.2)] p-6">
          <div className="flex justify-between items-center gap-2 mb-4">
            <h2 className="text-xl font-bold">Lobby</h2>
            <button
              onClick={() => router.push("/casino/uno")}
              className="px-4 py-2 bg-[#f5ff3b] text-[#031026] rounded-lg font-semibold"
            >
              Back to Neon Flush
            </button>
          </div>

          {!unoMultiTableCode ? (
            <>
              <div className="grid md:grid-cols-2 gap-3">
                <label htmlFor="uno-multi-table-name" className="sr-only">Table name</label>
                <input
                  id="uno-multi-table-name"
                  value={unoMultiSettings.gameName}
                  onChange={(e) =>
                    setUnoMultiSettings((s) => ({
                      ...s,
                      gameName: e.target.value,
                    }))
                  }
                  className="bg-[#001933] border border-[#00e5ff]/35 rounded px-3 py-2"
                  placeholder="Table name"
                />
                <select
                  value={unoMultiSettings.visibility}
                  onChange={(e) =>
                    setUnoMultiSettings((s) => ({
                      ...s,
                      visibility: e.target.value,
                    }))
                  }
                  className="bg-[#001933] border border-[#00e5ff]/35 rounded px-3 py-2"
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
                <label htmlFor="uno-multi-bet-amount" className="sr-only">Bet amount</label>
                <input
                  id="uno-multi-bet-amount"
                  type="number"
                  min={1}
                  max={1000}
                  value={unoMultiSettings.betAmount}
                  onChange={(e) =>
                    setUnoMultiSettings((s) => ({
                      ...s,
                      betAmount: Number(e.target.value) || 1,
                    }))
                  }
                  className="bg-[#001933] border border-[#00e5ff]/35 rounded px-3 py-2"
                  placeholder="Bet amount"
                />
                <select
                  value={unoMultiSettings.maxPlayers}
                  onChange={(e) =>
                    setUnoMultiSettings((s) => ({
                      ...s,
                      maxPlayers: Number(e.target.value),
                    }))
                  }
                  className="bg-[#001933] border border-[#00e5ff]/35 rounded px-3 py-2"
                >
                  <option value={3}>3 Players</option>
                  <option value={4}>4 Players</option>
                  <option value={5}>5 Players</option>
                  <option value={6}>6 Players</option>
                </select>
              </div>
              <button
                onClick={createUnoMultiplayerTable}
                className="mt-4 w-full rounded-lg bg-[#f5ff3b] text-[#031026] font-bold py-2"
              >
                Create Table
              </button>

              <div className="mt-3 flex gap-2">
                <label htmlFor="uno-multi-invite-code" className="sr-only">Invite code</label>
                <input
                  id="uno-multi-invite-code"
                  value={unoMultiJoinCode}
                  onChange={(e) => setUnoMultiJoinCode(e.target.value.toUpperCase())}
                  className="flex-1 bg-[#001933] border border-[#00e5ff]/35 rounded px-3 py-2"
                  placeholder="Invite code"
                />
                <button
                  onClick={joinUnoPrivateTable}
                  className="px-4 py-2 rounded bg-[#00e5ff] text-[#001933] font-semibold"
                >
                  Join code
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-[#a5f3fc] mb-2">
                Table code: <span className="font-bold text-yellow-300">{unoMultiTableCode}</span>
              </p>
              <label className="inline-flex items-center gap-2 mb-3 text-sm text-yellow-100">
                <input
                  type="checkbox"
                  checked={unoMultiSkipRound}
                  onChange={(e) => setUnoMultiSkipRound(e.target.checked)}
                />{" "}
                Skip next round
              </label>
              <div className="relative w-full h-[320px] rounded-3xl bg-gradient-to-br from-[#001a33] via-[#000d1f] to-[#000814] border-4 border-[#020617]">
                {UNO_MULTI_SEAT_POSITIONS.map((pos, seatIndex) => {
                  const isEnabledSeat = seatIndex < unoMultiSettings.maxPlayers;
                  const occupant = unoMultiPlayers.find((p) => p.seatIndex === seatIndex);
                  return (
                    <div
                      key={seatIndex}
                      className="absolute"
                      style={{
                        left: pos.left,
                        top: pos.top,
                        transform: "translate(-50%, -50%)",
                      }}
                    >
                      {isEnabledSeat ? (
                        occupant ? (
                          <div
                            className={`w-28 h-12 rounded-xl border flex items-center justify-center text-xs font-semibold ${occupant.id === unoMultiMyId ? "bg-yellow-300 text-black border-yellow-100" : "bg-[#08142f] border-[#00e5ff]/35"}`}
                          >
                            <span className="inline-flex items-center gap-1">
                              {occupant.type === "ai" ? (
                                <IconRobot size={14} />
                              ) : (
                                <IconAvatar iconKey={occupant.iconKey} name={occupant.name} size="h-4 w-4" />
                              )}
                              <span className="truncate" style={occupant.nameColor ? { color: occupant.nameColor } : undefined}>
                                {occupant.name}
                              </span>
                              {(occupant as any).prestigeBadge && (
                                <span className="ml-0.5 inline-block rounded-full border border-violet-400/70 bg-violet-500/15 px-1 py-px align-middle text-[8px] font-semibold uppercase tracking-wide text-violet-300">
                                  {(occupant as any).prestigeBadge}
                                </span>
                              )}
                            </span>
                          </div>
                        ) : (
                          <button
                            onClick={() => {
                              setSelectedSeat(seatIndex);
                              setShowSeatPopup(true);
                            }}
                            disabled={Boolean(occupant)}
                            className="w-28 h-12 rounded-xl border border-dashed text-xs border-[#00e5ff]/45 hover:bg-[#00e5ff]/20"
                          >
                            {meSeated ? (isHost ? "+ Add AI" : "Occupied") : "Claim Seat"}
                          </button>
                        )
                      ) : (
                        <div className="w-28 h-12 rounded-xl border border-gray-600 bg-gray-800/40 text-[10px] flex items-center justify-center text-gray-400">
                          Disabled
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 flex gap-3">
                <button
                  onClick={startUnoMultiplayerGame}
                  disabled={meSeated ? !isHost : false}
                  className="flex-1 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 px-4 py-2 rounded font-bold"
                >
                  Start
                </button>
                <button
                  onClick={resetUnoMultiplayerLobby}
                  className="flex-1 bg-red-600 hover:bg-red-500 px-4 py-2 rounded font-bold"
                >
                  Leave
                </button>
              </div>
            </>
          )}

          <div className="mt-4 rounded-lg border border-[#00e5ff]/30 p-3 bg-[#001933]">
            <div className="mb-2 flex justify-between items-center">
              <p className="font-semibold">Available public games</p>
              <button
                onClick={fetchUnoMultiplayerPublicGames}
                className="px-2 py-1 rounded bg-[#00e5ff] text-[#001933] text-xs font-semibold"
              >
                Refresh
              </button>
            </div>
            <div className="space-y-2">
              {unoMultiPublicGames.length === 0 && (
                <p className="text-sm text-gray-300">No public games right now.</p>
              )}
              {unoMultiPublicGames.slice(0, 8).map((entry) => (
                <div
                  key={entry.code}
                  className="flex items-center justify-between bg-[#0d335f]/80 rounded px-3 py-2"
                >
                  <span className="text-sm">
                    {entry.name} ({entry.occupiedSeats}/{entry.maxPlayers}) • Bet {entry.betAmount}
                  </span>
                  <button
                    onClick={() => joinUnoPublicTable(entry.code)}
                    className="px-3 py-1 rounded bg-[#00e5ff] text-[#001933] font-semibold"
                  >
                    Join
                  </button>
                </div>
              ))}
            </div>
          </div>

          {showSeatPopup && selectedSeat !== null && (
            <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center">
              <div className="bg-[#08142f] border border-[#00e5ff]/40 rounded-2xl p-6 w-[320px] text-center">
                <h2 className="text-xl font-bold mb-4">Seat {selectedSeat + 1}</h2>

                {!meSeated && (
                  <button
                    onClick={() => sitAsHuman(selectedSeat)}
                    className="w-full mb-3 py-2 rounded bg-yellow-300 text-black font-bold"
                  >
                    Sit Here
                  </button>
                )}

                {isHost && (
                  <button
                    onClick={() => addUnoMultiAiToSeat(selectedSeat)}
                    className="w-full mb-3 py-2 rounded bg-cyan-400 text-black font-bold"
                  >
                    Add AI Here
                  </button>
                )}

                <button
                  onClick={() => {
                    setShowSeatPopup(false);
                    setSelectedSeat(null);
                  }}
                  className="w-full py-2 rounded bg-red-600 font-bold"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {unoMultiMessage && <p className="mt-4 text-yellow-200 text-sm">{unoMultiMessage}</p>}
        </div>
      ) : (
        <CreatorModeHost
          autoStart={Boolean(game)}
          autoStop={Boolean(endPopup)}
          autoStopOnIdle
          gameLabel="uno-multiplayer"
          backToLobbyHref="/uno/multiplayer"
        >
        <CreatorView
          normal={normalView}
          portrait={portraitContent}
          landscape={landscapeContent}
        />

        {/* Post-match result screen — shared PvpResultScreen (UX plan
            P3-3). Mounted INSIDE CreatorModeHost so it appears in the
            recording; compact styling keeps it sized for the phone frame. */}
        {renderResult()}
        </CreatorModeHost>
      )}

      <ReportModal
        isOpen={showReportModal && !!humanOpponent}
        onClose={() => setShowReportModal(false)}
        onSubmit={async (reason, details) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: humanOpponent?.userId,
              gameType: "uno",
              gameId: game?.id ? String(game.id) : null,
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={humanOpponent?.name || "Opponent"}
        gameType="UNO"
      />
      <Footer />
    </motion.div>
  );
}
