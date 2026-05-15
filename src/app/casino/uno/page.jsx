"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import UnoCard from "../../../components/UnoCard";
import UnoBack from "../../../components/UnoBack";
import NavigationBar from "../../../components/navigation-bar";
import { useSocket } from "../../../context/SocketProvider";
import useGamePresence from "../../../hooks/useGamePresence";

export default function UnoGamePage() {
  const router = useRouter();
  const { socket } = useSocket();

  const [game, setGame] = useState(null);
  const [gameMode, setGameMode] = useState("ai");
  const [playerHand, setPlayerHand] = useState([]);
  const [aiHandCount, setAiHandCount] = useState(0);
  const [topCard, setTopCard] = useState(null);
  const [isPlayerTurn, setIsPlayerTurn] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [betAmount, setBetAmount] = useState(100);
  const [tokens, setTokens] = useState(null);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [pendingCard, setPendingCard] = useState(null);
  const [turnHistory, setTurnHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(null);
  const [showGameModeModal, setShowGameModeModal] = useState(false);
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

  const waitingPollRef = useRef(null);
  const replayClientIdRef = useRef(Math.random().toString(36).slice(2));

  const openEndPopup = (result, reason = "finished") => {
    setEndPopup({ result, reason, openedAt: Date.now() });
    setReplayRequested(false);
    setOpponentReplayRequested(false);
    setReturnChosen(false);
    setReplaySecondsLeft(15);
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
      setMessage("Replay accepted by both players. Create or join a new table.");
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
          setMessage(youWon ? "Tu as gagné la partie !" : "Ton adversaire a gagné la partie !");
        } else {
          setMessage(`${data.winner} a gagné la partie !`);
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
      setMessage("À ton tour !");
      setEndPopup(null);
      setTokens({ balance: data.data.newBalance });
    } else {
      setMessage("Erreur d'initialisation");
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
        setMessage(data.data.message || "À ton tour !");
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
      setMessage(data.data.message || "À ton tour !");
      setPendingCard(null);
      setShowColorPicker(false);
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
              ? "✅ Partie trouvée ! Tu commences."
              : "✅ Partie trouvée ! L'adversaire commence."
          );
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
        setMessage("✅ Partie annulée.");
        if (data.newBalance) setTokens({ balance: data.newBalance });
        fetchAvailableGames();
        socket?.emit("room_event", {
          roomId: "lobby:uno",
          event: "lobby:updated",
        });
      } else {
        setMessage(data.error || "Impossible d'annuler la partie.");
      }
    } catch (err) {
      console.error("Erreur cancelWaitingOnlineGame:", err);
      setMessage("Impossible d'annuler la partie.");
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
        setIsPlayerTurn(isMyTurn);
        setMessage(
          isMyTurn
            ? "✅ Partie en ligne trouvée ! Tu commences."
            : "✅ Partie en ligne trouvée ! L'adversaire commence."
        );
        setTokens({ balance: data.data.newBalance });
        fetchAvailableGames();
        socket?.emit("room_event", {
          roomId: "lobby:uno",
          event: "lobby:updated",
        });
      } else {
        setMessage(data.error || "Impossible de rejoindre cette partie");
      }
    } catch (err) {
      console.error("Erreur joinSpecificOnlineGame:", err);
      setMessage("Impossible de rejoindre cette partie");
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
        setIsPlayerTurn(isMyTurn);
        setMessage(
          isMyTurn
            ? "✅ Partie en ligne trouvée ! Tu commences."
            : "✅ Partie en ligne trouvée ! L'adversaire commence."
        );
        setTokens({ balance: data.data.newBalance });
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
      setMessage("Impossible de rejoindre une partie");
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
        setMessage("⏳ En attente d'un autre joueur...");
        setGameMode("online");
        setWaitingGameId(data.gameId);
        if (data.newBalance) setTokens({ balance: data.newBalance });
        waitForOnlineGameStart(data.gameId);
        fetchAvailableGames();
      } else {
        setMessage(data.error || "Impossible de créer la partie en ligne");
      }
    } catch (err) {
      console.error("Erreur createOnlineGame:", err);
      setMessage("Impossible de créer la partie en ligne");
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
          setMessage(youWon ? "Tu as gagné la partie !" : "Ton adversaire a gagné la partie !");
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
        alert(data.error || "Impossible d'abandonner");
        return;
      }
      setMessage(
        gameMode === "online" ? "😢 Tu as abandonné la partie." : "😢 Tu as abandonné contre l'IA."
      );
      setIsPlayerTurn(false);
      if (data.newBalance) setTokens({ balance: data.newBalance });
      openEndPopup("loss", "resigned");
    } catch (err) {
      console.error("Erreur resign:", err);
      alert("Erreur lors de l'abandon");
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
      setMessage(gameMode === "ai" ? "L'IA joue..." : "Tour suivant...");
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

  return (
    <div className="page-enter mt-0 flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-4 md:pb-8">
      <NavigationBar currentPath="/casino" />
      {endPopup && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm">
          <div className="relative w-full max-w-md overflow-hidden rounded-3xl border border-cyan-300/60 bg-[#071124] p-6 text-center shadow-[0_0_45px_rgba(0,229,255,0.35),inset_0_0_30px_rgba(217,70,239,0.12)]">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-cyan-300 via-fuchsia-500 to-yellow-300" />
            <p className="text-xs font-black uppercase tracking-[0.45em] text-cyan-200">
              UNO Result
            </p>
            <h2
              className={`mt-3 text-4xl font-black uppercase ${endPopup.result === "win" ? "text-emerald-300" : "text-fuchsia-300"}`}
            >
              {endPopup.result === "win"
                ? "Victory"
                : endPopup.reason === "resigned"
                  ? "Resigned"
                  : "Defeat"}
            </h2>
            <p className="mt-3 text-sm text-slate-200">
              {endPopup.result === "win"
                ? "You won the match."
                : endPopup.reason === "resigned"
                  ? "You resigned the match."
                  : "Your opponent won the match."}
            </p>
            <p className="mt-4 text-xs font-bold uppercase tracking-widest text-yellow-200">
              Replay window: {replaySecondsLeft}s
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
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
            </div>
            {gameMode === "online" && (
              <p className="mt-3 text-xs text-slate-300">
                {returnChosen
                  ? "A player chose the lobby. Replay is disabled."
                  : opponentReplayRequested
                    ? "Opponent is ready for replay."
                    : "Both players must click replay before the timer ends."}
              </p>
            )}
          </div>
        </div>
      )}
      <h1 className="text-3xl mb-2 font-bold">
        {gameMode === "online" ? "UNO 1v1 en ligne" : "UNO vs IA"}
      </h1>

      {tokens && <p className="text-yellow-300 mb-4 text-lg">Tokens : {tokens.balance}</p>}

      {!game ? (
        <div className="casino-surface flex w-full max-w-4xl flex-col items-center justify-center rounded-[1.5rem] border-2 border-[#00e5ff]/35 bg-[#0b224f]/85 p-4 text-center shadow-[0_0_28px_rgba(0,229,255,0.2)] sm:aspect-[2/1] sm:rounded-[2rem] sm:p-8">
          <h2 className="text-2xl font-bold mb-6 text-white">Prépare ta partie</h2>

          <label className="mb-6 text-lg font-semibold flex flex-col items-center">
            <span className="mb-2">Mise :</span>
            <input
              type="number"
              value={betAmount}
              onChange={(e) => setBetAmount(Number(e.target.value))}
              className="bg-[#08142f] border border-[#00e5ff]/40 text-white px-3 py-1 rounded text-center w-32"
              min={1}
              max={1000}
            />
          </label>

          <button
            onClick={() => setShowGameModeModal(true)}
            disabled={loading || !!waitingGameId}
            className="px-8 py-3 rounded-full font-bold text-[#031026] bg-[#f5ff3b] hover:bg-[#edf734]"
          >
            {loading ? "Chargement..." : "Commencer une partie"}
          </button>
          <button
            onClick={joinOnlineGame}
            disabled={loading || !!waitingGameId}
            className="mt-4 px-8 py-3 rounded-full font-bold text-[#001933] bg-[#00e5ff] hover:bg-[#49eeff]"
          >
            {loading ? "Recherche..." : "Rejoindre une partie"}
          </button>
          <button
            onClick={() => router.push("/uno/multiplayer")}
            className="mt-4 px-8 py-3 rounded-full font-bold text-[#001933] bg-green-300 hover:bg-green-200"
          >
            Multiplayer Table Mode
          </button>

          {waitingGameId && (
            <button
              onClick={cancelWaitingOnlineGame}
              disabled={isCancellingWaitingGame}
              className="mt-3 bg-red-600 hover:bg-red-500 text-white px-8 py-2 rounded-full font-bold"
            >
              {isCancellingWaitingGame ? "Annulation..." : "Annuler la partie en attente"}
            </button>
          )}

          <div className="mt-6 w-full max-w-md bg-[#08142f] rounded-2xl p-4 border border-[#00e5ff]/30">
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-lg font-bold">Parties en ligne disponibles</h3>
              <button
                onClick={fetchAvailableGames}
                disabled={isLoadingAvailableGames}
                className="bg-[#00e5ff] text-[#001933] px-3 py-1 rounded-md text-sm font-semibold"
              >
                {isLoadingAvailableGames ? "..." : "🔄 Refresh"}
              </button>
            </div>
            {isLoadingAvailableGames ? (
              <p className="text-sm text-gray-200">Chargement des parties...</p>
            ) : availableGames.length === 0 ? (
              <p className="text-sm text-gray-200">Aucune partie en attente pour le moment.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {availableGames.slice(0, 6).map((onlineGame) => (
                  <li
                    key={onlineGame.id}
                    className="flex justify-between items-center bg-[#0d335f]/80 border border-[#00e5ff]/20 rounded-lg px-3 py-2"
                  >
                    <span>
                      {onlineGame.hostName} • Mise: {onlineGame.betAmount}
                    </span>
                    <button
                      onClick={() => joinSpecificOnlineGame(onlineGame.id)}
                      disabled={!onlineGame.canAfford || loading || !!waitingGameId}
                      className={`px-3 py-1 rounded-md font-semibold ${onlineGame.canAfford && !waitingGameId ? "bg-[#00e5ff] text-[#001933]" : "bg-gray-600 text-gray-200 cursor-not-allowed"}`}
                    >
                      {onlineGame.canAfford ? "Rejoindre" : "Solde insuffisant"}
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
                  Choisir un mode
                </h3>
                <div className="flex flex-col gap-3">
                  <button
                    onClick={() => {
                      setShowGameModeModal(false);
                      initializeGame();
                    }}
                    className="px-4 py-2 rounded-lg font-bold bg-[#00e5ff] text-[#001933]"
                  >
                    Jouer contre l'IA
                  </button>
                  <button
                    onClick={createOnlineGame}
                    disabled={!!waitingGameId}
                    className="px-4 py-2 rounded-lg font-bold bg-[#00e5ff] text-[#001933]"
                  >
                    Créer une partie 1v1
                  </button>
                  <button
                    onClick={() => setShowGameModeModal(false)}
                    className="bg-red-600 text-white px-4 py-2 rounded-lg font-semibold"
                  >
                    Annuler
                  </button>
                </div>
              </div>
            </div>
          )}

          {message && <p className="mt-6 text-yellow-300 text-lg font-medium">{message}</p>}
        </div>
      ) : (
        <div className="casino-surface relative flex min-h-[560px] w-full max-w-5xl flex-col items-center justify-between overflow-hidden rounded-[1.5rem] border-4 border-green-950 bg-green-700/90 p-3 pb-32 shadow-2xl sm:min-h-[640px] sm:rounded-[2.5rem] sm:border-8 sm:p-6 sm:pb-36">
          <div className={`px-4 py-1 rounded-full ${!isPlayerTurn ? "turn-active-glow" : ""}`}>
            {gameMode === "online" ? "Main adverse:" : "Main de l'IA:"}
          </div>
          <div className="flex justify-center gap-2 flex-wrap max-w-4xl">
            {Array(aiHandCount)
              .fill(0)
              .map((_, i) => (
                <UnoBack key={i} />
              ))}
          </div>

          {showColorPicker && (
            <div className="absolute inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
              <div className="bg-white p-8 rounded-2xl shadow-xl text-black flex flex-col items-center gap-6">
                <h2 className="text-xl font-bold mb-2">Choisis une couleur 🎨</h2>
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { color: "red", label: "Rouge" },
                    { color: "blue", label: "Bleu" },
                    { color: "green", label: "Vert" },
                    { color: "yellow", label: "Jaune" },
                  ].map(({ color, label }) => (
                    <button
                      key={color}
                      onClick={() => {
                        setShowColorPicker(false);
                        sendPlayCard(pendingCard, color);
                      }}
                      className="w-24 h-24 rounded-xl font-bold text-white"
                      style={{ backgroundColor: color }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-center gap-6 mb-4">
            <button
              onClick={() =>
                setHistoryIndex((prev) =>
                  turnHistory.length <= 1
                    ? null
                    : prev === null
                      ? turnHistory.length - 2
                      : Math.max(prev - 1, 0)
                )
              }
              disabled={turnHistory.length <= 1 || historyIndex === 0}
              className="text-3xl font-bold text-yellow-300 disabled:opacity-30"
            >
              ⬅️
            </button>
            <div className="flex flex-col items-center">
              Carte actuelle :
              {displayedCard ? (
                <UnoCard
                  color={displayedCard.color}
                  value={displayedCard.value}
                  onClick={() => {}}
                />
              ) : (
                <span className="font-bold ml-2">?</span>
              )}
            </div>
            <button
              onClick={() =>
                setHistoryIndex((prev) =>
                  prev === null ? null : prev >= turnHistory.length - 2 ? null : prev + 1
                )
              }
              disabled={historyIndex === null}
              className="text-3xl font-bold text-yellow-300 disabled:opacity-30"
            >
              ➡️
            </button>
          </div>

          <div
            className={`flex flex-wrap gap-2 justify-center px-3 py-2 rounded-2xl ${isPlayerTurn ? "turn-active-glow" : ""}`}
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

          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center relative z-50">
            <button
              onClick={drawCard}
              className="mb-2 px-5 py-2 rounded-full font-bold bg-[#f5ff3b] text-[#031026]"
            >
              Piocher une carte
            </button>
            {game && !message.includes("gagné") && (
              <button
                onClick={resignGame}
                disabled={isResigning}
                className="mt-3 px-6 py-2 rounded-full font-bold text-white bg-red-600 hover:bg-red-500"
              >
                {isResigning ? "Abandon..." : "❌ Abandonner"}
              </button>
            )}
            <button
              onClick={returnToLobby}
              className="mt-2 bg-[#f5ff3b] text-black px-6 py-2 rounded"
            >
              Lobby
            </button>
          </div>

          {message && <p className="mt-6 text-yellow-300 text-lg font-medium">{message}</p>}
        </div>
      )}
    </div>
  );
}
