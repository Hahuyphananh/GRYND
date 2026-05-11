"use client";
import { useEffect, useState, useRef } from "react";
import NavigationBar from "../../../components/navigation-bar";
import { useSocket } from "../../../context/SocketProvider";

const PVP_CHOICES = ["rock", "paper", "scissors"];

export default function RPSGame() {
  const { socket } = useSocket();
  const [tokens, setTokens] = useState(0);
  const [betAmount, setBetAmount] = useState(10);
  const [playerChoice, setPlayerChoice] = useState<string | null>(null);
  const [aiChoice, setAiChoice] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRpsRules, setShowRpsRules] = useState(false);

  const [winStreak, setWinStreak] = useState(0);
  const [multiplier, setMultiplier] = useState(1.0);
  const [mode, setMode] = useState("pve"); // "pve" | "pvp"

  const [autoBet, setAutoBet] = useState({
    enabled: false,
    mode: "finite" as "finite" | "infinite",
    spinsLeft: 0,
  });

  // PvP state
  const [pvpGames, setPvpGames] = useState<any[]>([]);
  const [isLoadingPvpGames, setIsLoadingPvpGames] = useState(false);
  const [pvpGameId, setPvpGameId] = useState<number | null>(null);
  const [pvpStatus, setPvpStatus] = useState<string | null>(null);
  const [pvpPlayer1Id, setPvpPlayer1Id] = useState<string | null>(null);
  const [pvpPlayer2Id, setPvpPlayer2Id] = useState<string | null>(null);
  const [pvpMyName, setPvpMyName] = useState<string>("You");
  const [pvpOpponentName, setPvpOpponentName] = useState<string>("Opponent");
  const [pvpMyChoice, setPvpMyChoice] = useState<string | null>(null);
  const [pvpOpponentChoice, setPvpOpponentChoice] = useState<string | null>(
    null,
  );
  const [pvpOutcome, setPvpOutcome] = useState<string | null>(null);
  const [pvpWinner, setPvpWinner] = useState<string | null>(null);
  const [pvpWinnerPayout, setPvpWinnerPayout] = useState<number | null>(null);
  const [pvpWinnerProfit, setPvpWinnerProfit] = useState<number | null>(null);
  const [pvpHouseFee, setPvpHouseFee] = useState<number | null>(null);
  const [pvpCountdown, setPvpCountdown] = useState<number | null>(null);
  const [pvpMessage, setPvpMessage] = useState<string>("");
  const [pvpActionLoading, setPvpActionLoading] = useState(false);

  const autoBetRef = useRef(autoBet);
  autoBetRef.current = autoBet;

  const choices = ["rock", "paper", "scissors"];

  useEffect(() => {
    fetch("/api/get-user-tokens", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    })
      .then((res) => res.json())
      .then((data) => setTokens(data.data.balance))
      .catch(() => setTokens(0));
  }, []);

  useEffect(() => {
    if (mode === "pvp") {
      fetchAvailablePvpGames();
    }
  }, [mode]);

  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:rps";
    const handleLobbyUpdate = () => {
      if (mode === "pvp") fetchAvailablePvpGames();
    };
    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", handleLobbyUpdate);
    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", handleLobbyUpdate);
    };
  }, [socket, mode]);

  useEffect(() => {
    if (!pvpGameId) return;

    const poll = async () => {
      try {
        const res = await fetch(`/api/rps/pvp/status?gameId=${pvpGameId}`);
        const data = await res.json();
        if (!data.success) return;

        const game = data.data;
        setPvpStatus(game.status);
        setPvpPlayer1Id(game.player1Id || null);
        setPvpPlayer2Id(game.player2Id || null);
        setPvpMyName(game.myName || "You");
        setPvpOpponentName(game.opponentName || "Opponent");
        setPvpMyChoice(game.myChoice || null);
        setPvpOpponentChoice(game.opponentChoice || null);
        setPvpOutcome(game.outcome || null);
        setPvpWinner(game.winner || null);
        setPvpWinnerPayout(
          typeof game.winnerPayout === "number" ? game.winnerPayout : null,
        );
        setPvpWinnerProfit(
          typeof game.winnerProfit === "number" ? game.winnerProfit : null,
        );
        setPvpHouseFee(
          typeof game.houseFee === "number" ? game.houseFee : null,
        );

        if (game.status === "active") {
          setPvpMessage("Waiting for opponent...");
        } else if (game.status === "matched" && !game.myChoice) {
          setPvpMessage("Opponent joined. Pick rock, paper, or scissors.");
        } else if (
          game.status === "matched" &&
          game.myChoice &&
          !game.opponentChoice
        ) {
          setPvpMessage("Choice locked. Waiting for opponent choice...");
        } else if (game.status === "finished") {
          if (game.winner === "you") {
            setPvpMessage("🎉 You won the PvP match!");
          } else if (game.winner === "opponent") {
            setPvpMessage("😢 You lost the PvP match.");
          } else {
            setPvpMessage("🤝 It's a tie.");
          }
          if (typeof game.newBalance === "number") {
            setTokens(game.newBalance);
          }
        } else if (game.status === "cancelled") {
          setPvpMessage("Game cancelled.");
          if (typeof game.newBalance === "number") {
            setTokens(game.newBalance);
          }
        }
      } catch (err) {
        console.error("Failed to poll RPS PvP status:", err);
      }
    };

    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [pvpGameId]);

  useEffect(() => {
    if (pvpStatus !== "matched") {
      setPvpCountdown(null);
      return;
    }

    setPvpCountdown(10);
    const countdownInterval = setInterval(() => {
      setPvpCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(countdownInterval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(countdownInterval);
  }, [pvpStatus, pvpGameId]);

  const calculateMultiplier = (streak: number) => {
    if (streak <= 0) return 1.0;
    return 1.9;
  };

  const winStreakRef = useRef(winStreak);
  winStreakRef.current = winStreak;

  const multiplierRef = useRef(multiplier);
  multiplierRef.current = multiplier;

  const formatOutcome = (outcome) => {
    if (!outcome) return "";

    const player1Name =
      pvpPlayer1Id && pvpPlayer1Id === pvpPlayer1Id
        ? pvpMyName
        : pvpOpponentName;

    const player2Name =
      pvpPlayer2Id && pvpPlayer2Id === pvpPlayer2Id
        ? pvpMyName
        : pvpOpponentName;

    return outcome
      .replace(/player1/g, player1Name)
      .replace(/player2/g, player2Name);
  };

  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const placeBet = async () => {
    if (!playerChoice) {
      alert("Please choose Rock, Paper, or Scissors first!");
      if (autoBetRef.current.enabled) {
        setAutoBet((prev) => ({ ...prev, enabled: false }));
      }
      return;
    }
    if (betAmount <= 0 || betAmount > tokens) {
      alert("Invalid bet amount!");
      if (autoBetRef.current.enabled) {
        setAutoBet((prev) => ({ ...prev, enabled: false }));
      }
      return;
    }

    setTokens((prev) => prev - betAmount);

    setLoading(true);
    setResult(null);
    setAiChoice(null);

    await delay(1000);

    const res = await fetch("/api/rps/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        betAmount,
        choice: playerChoice,
        winStreak: winStreakRef.current,
      }),
    });

    const data = await res.json();

    setTokens(data.newBalance);
    setAiChoice(data.aiChoice);
    setResult(data.result);

    if (data.result === "win") {
      const newStreak = winStreakRef.current + 1;
      setWinStreak(newStreak);
      winStreakRef.current = newStreak;
      const newMultiplier = calculateMultiplier(newStreak);
      setMultiplier(newMultiplier);
      multiplierRef.current = newMultiplier;
    } else if (data.result === "lose") {
      setWinStreak(0);
      winStreakRef.current = 0;
      setMultiplier(1.0);
      multiplierRef.current = 1.0;
    } else if (data.result === "tie") {
      setWinStreak(0);
      winStreakRef.current = 0;
      setMultiplier(1.0);
      multiplierRef.current = 1.0;
    }

    setLoading(false);

    if (autoBetRef.current.enabled) {
      if (
        autoBetRef.current.mode === "finite" &&
        autoBetRef.current.spinsLeft <= 1
      ) {
        setAutoBet({ enabled: false, mode: "finite", spinsLeft: 0 });
      } else {
        if (autoBetRef.current.mode === "finite") {
          setAutoBet((prev) => ({
            ...prev,
            spinsLeft: prev.spinsLeft - 1,
          }));
        }
        setTimeout(() => {
          placeBet();
        }, 1500);
      }
    }
  };

  const fetchAvailablePvpGames = async () => {
    setIsLoadingPvpGames(true);
    try {
      const res = await fetch("/api/rps/pvp/available");
      const data = await res.json();
      if (data.success) {
        setPvpGames(data.data.games || []);
      }
    } catch (err) {
      console.error("Failed to fetch available RPS PvP games:", err);
    }
    setIsLoadingPvpGames(false);
  };

  const createPvpGame = async () => {
    if (betAmount <= 0 || betAmount > tokens) {
      alert("Invalid bet amount!");
      return;
    }

    setPvpActionLoading(true);
    setPvpMessage("Creating game...");
    try {
      const res = await fetch("/api/rps/pvp/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount }),
      });
      const data = await res.json();
      if (!data.success) {
        setPvpMessage(data.error || "Failed to create game");
      } else {
        setPvpGameId(data.data.gameId);
        setPvpStatus("active");
        setPvpPlayer1Id(data.data.player1Id);
        setPvpPlayer2Id(null);
        setPvpMyName("You");
        setPvpOpponentName("Waiting...");
        setPvpMyChoice(null);
        setPvpOpponentChoice(null);
        setPvpOutcome(null);
        setPvpWinner(null);
        setPvpWinnerPayout(null);
        setPvpWinnerProfit(null);
        setPvpHouseFee(null);
        setTokens(data.data.newBalance);
        setPvpMessage("Game created. Waiting for opponent...");
        fetchAvailablePvpGames();
        socket?.emit("room_event", {
          roomId: "lobby:rps",
          event: "lobby:updated",
        });
      }
    } catch (err) {
      console.error("Failed to create RPS PvP game:", err);
      setPvpMessage("Failed to create game");
    }
    setPvpActionLoading(false);
  };

  const joinPvpGame = async (gameId: number) => {
    setPvpActionLoading(true);
    setPvpMessage("Joining game...");
    try {
      const res = await fetch("/api/rps/pvp/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (!data.success) {
        setPvpMessage(data.error || "Failed to join game");
      } else {
        setPvpGameId(gameId);
        setPvpStatus("matched");
        setPvpPlayer1Id(data.data.player1Id);
        setPvpPlayer2Id(data.data.player2Id);
        setPvpMyName("You");
        setPvpOpponentName("Opponent");
        setPvpMyChoice(null);
        setPvpOpponentChoice(null);
        setPvpOutcome(null);
        setPvpWinner(null);
        setPvpWinnerPayout(null);
        setPvpWinnerProfit(null);
        setPvpHouseFee(null);
        setTokens(data.data.newBalance);
        setPvpMessage("Joined game. Pick your move.");
        fetchAvailablePvpGames();
        socket?.emit("room_event", {
          roomId: "lobby:rps",
          event: "lobby:updated",
        });
      }
    } catch (err) {
      console.error("Failed to join RPS PvP game:", err);
      setPvpMessage("Failed to join game");
    }
    setPvpActionLoading(false);
  };

  const choosePvpMove = async (choice: string) => {
    if (!pvpGameId || pvpStatus !== "matched" || pvpMyChoice) return;
    setPvpActionLoading(true);
    try {
      const res = await fetch("/api/rps/pvp/choose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: pvpGameId, choice }),
      });
      const data = await res.json();
      if (!data.success) {
        setPvpMessage(data.error || "Failed to save choice");
      } else {
        setPvpMyChoice(choice);
        setPvpMessage("Choice locked. Waiting for opponent...");
      }
    } catch (err) {
      console.error("Failed to choose RPS PvP move:", err);
      setPvpMessage("Failed to submit choice");
    }
    setPvpActionLoading(false);
  };

  const cancelPvpGame = async () => {
    if (!pvpGameId || pvpStatus !== "active") return;
    setPvpActionLoading(true);
    try {
      const res = await fetch("/api/rps/pvp/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: pvpGameId }),
      });
      const data = await res.json();
      if (!data.success) {
        setPvpMessage(data.error || "Failed to cancel game");
      } else {
        if (typeof data.data.newBalance === "number") {
          setTokens(data.data.newBalance);
        }
        setPvpGameId(null);
        setPvpStatus(null);
        setPvpPlayer1Id(null);
        setPvpPlayer2Id(null);
        setPvpMyName("You");
        setPvpOpponentName("Opponent");
        setPvpMyChoice(null);
        setPvpOpponentChoice(null);
        setPvpOutcome(null);
        setPvpWinner(null);
        setPvpWinnerPayout(null);
        setPvpWinnerProfit(null);
        setPvpHouseFee(null);
        setPvpCountdown(null);
        setPvpMessage("Game cancelled");
        fetchAvailablePvpGames();
        socket?.emit("room_event", {
          roomId: "lobby:rps",
          event: "lobby:updated",
        });
      }
    } catch (err) {
      console.error("Failed to cancel RPS PvP game:", err);
      setPvpMessage("Failed to cancel game");
    }
    setPvpActionLoading(false);
  };

  return (
    <div className="flex flex-col md:flex-row min-h-screen bg-gradient-to-br from-[#001933] to-[#000d1a] text-white">
      <NavigationBar currentPath="/casino" />

      <div
        className="w-full max-w-[380px] md:max-w-[380px] bg-[#050d1f]/80 backdrop-blur-xl border border-[#a855f7]/40 
shadow-[0_0_25px_rgba(168,85,247,0.25),inset_0_0_25px_rgba(168,85,247,0.08)]
rounded-2xl p-6 flex flex-col gap-6 shadow-[0_0_24px_rgba(0,229,255,0.18)] mx-auto md:mx-0 mb-6 md:mb-0"
      >
        <h1
          className="text-3xl font-extrabold tracking-wider text-transparent bg-clip-text 
               bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] text-center whitespace-nowrap mt-20"
        >
          Rock Paper Scissors
        </h1>

        <p
          className="text-lg text-[#00e5ff] font-semibold 
              drop-shadow-[0_0_10px_rgba(0,229,255,0.8)] text-center md:text-left"
        >
          Your Tokens: {tokens}
        </p>

        <div className="flex justify-center gap-4">
          <button
            onClick={() => setMode("pve")}
            className={`px-5 py-2 rounded-xl font-bold transition-all duration-300
    ${
      mode === "pve"
        ? "bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] text-white shadow-[0_0_20px_#a855f7]"
        : "bg-[#1a2333] text-gray-400 border border-gray-600 hover:bg-[#2a3446]"
    }
  `}
          >
            PvE
          </button>

          <button
            onClick={() => setMode("pvp")}
            className={`px-5 py-2 rounded-xl font-bold transition-all duration-300
    ${
      mode === "pvp"
        ? "bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] text-white shadow-[0_0_20px_#a855f7]"
        : "bg-[#1a2333] text-gray-400 border border-gray-600 hover:bg-[#2a3446]"
    }
  `}
          >
            PvP
          </button>
        </div>

        <div className="flex items-center justify-center gap-2">
          <label
            className="text-lg text-[#00e5ff] font-semibold 
              drop-shadow-[0_0_10px_rgba(0,229,255,0.8)] text-center md:text-left"
          >
            Bet:
          </label>
          <input
            type="number"
            min={1}
            max={tokens}
            value={betAmount}
            onChange={(e) => setBetAmount(Number(e.target.value))}
            className="bg-[#020617] border border-[#00e5ff]/30 
focus:border-[#00e5ff] focus:shadow-[0_0_15px_rgba(0,229,255,0.6)]
rounded-xl px-3 py-2 text-white outline-none text-center w-24"
          />
        </div>

        {mode === "pve" && (
          <>
            <button
              onClick={placeBet}
              disabled={loading}
              className={`py-3 rounded-xl font-bold text-lg transition-all duration-300
  ${
    loading
      ? "bg-[#1a2333] text-gray-400 border border-gray-600"
      : "bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] text-[#001933] border border-[#00e5ff] shadow-[0_0_20px_rgba(0,229,255,0.6)] hover:shadow-[0_0_35px_rgba(0,255,166,1)] hover:scale-105"
  }
`}
            >
              {loading ? "Betting..." : "Place Bet"}
            </button>

            <div
              className="mt-4 bg-[#020617]/80 backdrop-blur-xl border border-[#00e5ff]/40 
rounded-xl p-4 shadow-[0_0_20px_rgba(0,229,255,0.2)] p-4 rounded-lg border border-[#00e5ff]/40 shadow-[0_0_16px_rgba(0,229,255,0.14)]"
            >
              <label className="flex items-center gap-2 font-semibold mb-2">
                <input
                  type="checkbox"
                  checked={autoBet.enabled}
                  onChange={(e) => {
                    if (
                      e.target.checked &&
                      (!playerChoice || betAmount <= 0 || betAmount > tokens)
                    ) {
                      alert(
                        "Select a valid choice and bet amount before enabling AutoBet.",
                      );
                      return;
                    }
                    setAutoBet((prev) => ({
                      ...prev,
                      enabled: e.target.checked,
                    }));
                  }}
                />
                Auto Bet
              </label>

              {autoBet.enabled && (
                <>
                  <select
                    value={autoBet.mode}
                    onChange={(e) =>
                      setAutoBet((prev) => ({
                        ...prev,
                        mode: e.target.value as "finite" | "infinite",
                      }))
                    }
                    className="w-full rounded border border-[#00e5ff]/40 bg-[#102542] px-2 py-1 text-center text-white"
                  >
                    <option value="finite">Finite</option>
                    <option value="infinite">Infinite</option>
                  </select>

                  {autoBet.mode === "finite" && (
                    <input
                      type="number"
                      min={1}
                      value={autoBet.spinsLeft}
                      onChange={(e) =>
                        setAutoBet((prev) => ({
                          ...prev,
                          spinsLeft: Number(e.target.value),
                        }))
                      }
                      className="w-full mt-2 rounded border border-[#00e5ff]/40 bg-[#102542] px-2 py-1 text-center text-white"
                    />
                  )}

                  <button
                    onClick={() =>
                      setAutoBet({
                        enabled: false,
                        mode: "finite",
                        spinsLeft: 0,
                      })
                    }
                    className="mt-2 w-full bg-red-600 hover:bg-red-700 text-white font-bold rounded px-4 py-2"
                  >
                    Stop AutoBet
                  </button>
                </>
              )}
            </div>
            {/* RPS Game Rules */}
            <div className="mt-4 bg-[#08142f] p-4 rounded-lg border border-[#00e5ff]/40 shadow-[0_0_16px_rgba(0,229,255,0.14)]">
              <button
                onClick={() => setShowRpsRules(!showRpsRules)}
                className="w-full text-left font-bold text-transparent bg-clip-text bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] flex justify-between items-center"
              >
                📜 Game Rules
                <span>{showRpsRules ? "▲" : "▼"}</span>
              </button>

              {showRpsRules && (
                <div className="mt-3 text-sm text-gray-200 space-y-3 leading-relaxed">
                  <p>
                    ✊ <strong>Objective:</strong> Beat the AI by choosing Rock,
                    Paper, or Scissors.
                  </p>

                  <p>
                    🔢 <strong>How to Play:</strong>
                    <br />• Select your move (✊ Rock, ✋ Paper, ✌️ Scissors) •
                    Choose your bet amount • Click <strong>
                      “Place Bet”
                    </strong>{" "}
                    to play
                  </p>

                  <p>
                    ⚔️ <strong>Rules:</strong>
                    <br />• Rock beats Scissors • Scissors beats Paper • Paper
                    beats Rock
                  </p>

                  <p>
                    🏆 <strong>Results:</strong>
                    <br />• Win → You earn a payout based on your bet and streak
                    • Lose → You lose your bet • Tie → Your bet is returned
                  </p>

                  <p>
                    🔥 <strong>Win Streak:</strong>
                    <br />• Winning multiple times in a row increases your
                    multiplier • Higher streak = higher rewards
                  </p>

                  <p>
                    💰 <strong>Multiplier(pve):</strong>
                    <br />• Your winnings increase with your streak • Lose or
                    tie → multiplier resets to 1.0
                  </p>

                  <p>
                    🤖 <strong>Auto Bet:</strong>
                    <br />• Automatically plays for you • Can run for a set
                    number of rounds or infinitely • Stops on invalid settings
                    or when you disable it
                  </p>

                  <p>
                    ⚠️ <strong>Important:</strong>
                    <br />• You must have enough tokens to bet • You must select
                    a move before betting • The game is based on chance
                  </p>
                </div>
              )}
            </div>
          </>
        )}

        {mode === "pvp" && (
          <>
            {!pvpGameId && (
              <button
                onClick={createPvpGame}
                disabled={pvpActionLoading}
                className="px-4 py-2 rounded-xl font-bold transition-all duration-300
           bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] text-[#001933]
           border border-[#00e5ff]
           shadow-[0_0_20px_rgba(0,229,255,0.6)]
           hover:shadow-[0_0_35px_rgba(0,255,166,1)] hover:scale-105"
              >
                Create Game
              </button>
            )}

            {pvpGameId && pvpStatus === "active" && (
              <button
                onClick={cancelPvpGame}
                disabled={pvpActionLoading}
                className="bg-red-600 hover:bg-red-700 px-6 py-3 rounded font-bold disabled:opacity-50"
              >
                Cancel Waiting Game
              </button>
            )}

            <div className="bg-[#08142f] p-4 rounded-lg border border-[#00e5ff]">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-[#a8f4ff]">Available Games</h3>
                <button
                  onClick={fetchAvailablePvpGames}
                  disabled={isLoadingPvpGames}
                  className="bg-[#00e5ff] text-[#001933] hover:bg-[#49eeff] px-3 py-1 rounded text-sm font-semibold disabled:opacity-50"
                >
                  {isLoadingPvpGames ? "Refreshing..." : "Refresh"}
                </button>
              </div>
              {pvpGames.length === 0 ? (
                <p className="text-sm text-gray-300">
                  No available games right now.
                </p>
              ) : (
                <ul className="space-y-2 max-h-48 overflow-auto pr-1">
                  {pvpGames.map((game) => (
                    <li
                      key={game.id}
                      className="bg-[#0d335f] rounded p-2 flex items-center justify-between gap-2"
                    >
                      <div className="text-sm">
                        <p className="font-semibold">
                          Host: {game.player1Name || "Unknown"}
                        </p>
                        <p>Bet: {game.betAmount}</p>
                      </div>
                      <button
                        onClick={() => joinPvpGame(game.id)}
                        disabled={pvpActionLoading || Boolean(pvpGameId)}
                        className="px-4 py-2 rounded-xl font-bold transition-all duration-300
           bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] text-[#001933]
           border border-[#00e5ff]
           shadow-[0_0_20px_rgba(0,229,255,0.6)]
           hover:shadow-[0_0_35px_rgba(0,255,166,1)] hover:scale-105"
                      >
                        Join
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {pvpMessage && (
              <p className="text-sm text-yellow-200">{pvpMessage}</p>
            )}
          </>
        )}
      </div>

      <main className="flex-1 flex flex-col items-center justify-center gap-8 ml-0 md:ml-6 w-full px-4 md:px-0">
        {mode === "pve" && (
          <>
            <div className="flex flex-col md:flex-row items-center gap-12">
              <div
                className="bg-[#020617]/80 backdrop-blur-xl border border-[#00e5ff]/40 
shadow-[0_0_20px_rgba(0,229,255,0.2)] w-32 h-44 flex items-center justify-center rounded-xl text-6xl"
              >
                {getEmoji(playerChoice)}
              </div>

              <div className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-[#a855f7] to-[#ff4fd8]">
                VS
              </div>

              <div
                className="bg-[#020617]/80 backdrop-blur-xl border border-[#00e5ff]/40 
shadow-[0_0_20px_rgba(0,229,255,0.2)] w-32 h-44 flex items-center justify-center rounded-xl text-6xl"
              >
                {getEmoji(aiChoice)}
              </div>
            </div>

            {result && (
              <div
                className={`text-2xl font-bold
  ${
    result === "win"
      ? "text-[#00ffa6] drop-shadow-[0_0_15px_rgba(0,255,166,1)]"
      : result === "lose"
        ? "text-red-400"
        : "text-gray-400"
  }
`}
              >
                {result.toUpperCase()}
              </div>
            )}

            <div className="flex gap-4 flex-wrap justify-center">
              {choices.map((choice) => (
                <button
                  key={choice}
                  onClick={() => setPlayerChoice(choice)}
                  className={`px-6 py-3 rounded-xl font-bold transition-all duration-300
  ${
    playerChoice === choice
      ? "bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] text-white shadow-[0_0_25px_#ff4fd8] scale-105"
      : "bg-[#020617] border border-[#00e5ff]/30 text-white hover:border-[#00e5ff] hover:shadow-[0_0_15px_rgba(0,229,255,0.6)]"
  }
`}
                >
                  {choice}
                </button>
              ))}
            </div>

            <div className="text-center w-full max-w-[400px]">
              <p className="text-xl">
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] font-bold">
                  Win Streak:
                </span>{" "}
                {winStreak}
              </p>
              <p className="text-xl">
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] font-bold">
                  Multiplier:
                </span>{" "}
                {multiplier.toFixed(2)}×
              </p>
            </div>
          </>
        )}

        {mode === "pvp" && (
          <div className="w-full max-w-2xl flex flex-col items-center gap-4">
            <div className="w-full flex justify-center gap-10 text-sm text-[#a8f4ff] font-semibold">
              <span>{pvpMyName}</span>
              <span>{pvpOpponentName}</span>
            </div>
            <div className="flex items-center gap-8">
              <div className="bg-[#0b224f] border border-[#00e5ff] w-28 h-36 flex items-center justify-center rounded-xl text-5xl">
                {getEmoji(pvpMyChoice)}
              </div>
              <div className="text-3xl font-bold text-[#7cefff]">VS</div>
              <div className="bg-[#0b224f] border border-[#00e5ff] w-28 h-36 flex items-center justify-center rounded-xl text-5xl">
                {pvpStatus === "finished" ? getEmoji(pvpOpponentChoice) : "❔"}
              </div>
            </div>

            {pvpGameId && (
              <p className="text-sm text-gray-300">Game ID: {pvpGameId}</p>
            )}

            {pvpStatus === "matched" && !pvpMyChoice && (
              <>
                <p className="text-sm text-yellow-300 font-semibold">
                  Choose your move within: {pvpCountdown ?? 10}s
                </p>
                <div className="flex gap-3 flex-wrap justify-center">
                  {PVP_CHOICES.map((choice) => (
                    <button
                      key={choice}
                      onClick={() => choosePvpMove(choice)}
                      disabled={pvpActionLoading}
                      className="px-5 py-2 rounded-lg font-bold bg-[#f5ff3b] hover:bg-[#d9e332] disabled:opacity-50"
                    >
                      {choice}
                    </button>
                  ))}
                </div>
              </>
            )}

            {pvpStatus === "finished" && (
              <div className="text-center">
                <p className="text-xl font-bold text-yellow-300">
                  Outcome:{" "}
                  {pvpWinner === "you"
                    ? `${pvpMyName} wins`
                    : pvpWinner === "opponent"
                      ? `${pvpOpponentName} wins`
                      : "It's a tie"}
                </p>
                <p className="text-lg">
                  Result:{" "}
                  {pvpWinner === "you"
                    ? "You win"
                    : pvpWinner === "opponent"
                      ? "You lose"
                      : "Tie"}
                </p>
                {pvpWinner === "you" && (
                  <p className="text-green-300">
                    You won {pvpWinnerPayout ?? 0} tokens total
                    {typeof pvpWinnerProfit === "number"
                      ? ` (+${pvpWinnerProfit} profit)`
                      : ""}
                    .
                  </p>
                )}
                {pvpWinner === "opponent" && (
                  <p className="text-red-300">You won 0 tokens this round.</p>
                )}
                {typeof pvpHouseFee === "number" && pvpWinner !== "tie" && (
                  <p className="text-xs text-gray-300">
                    House fee (10%): {pvpHouseFee} tokens.
                  </p>
                )}
                <button
                  onClick={() => window.location.reload()}
                  className="mt-3 bg-[#f5ff3b] hover:bg-[#d9e332] px-4 py-2 rounded font-semibold"
                >
                  Return
                </button>
              </div>
            )}

            {!pvpGameId && (
              <p className="text-yellow-300 font-semibold">
                Create or join a game to start PvP.
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function getEmoji(choice: string | null) {
  switch (choice) {
    case "rock":
      return "✊";
    case "paper":
      return "✋";
    case "scissors":
      return "✌️";
    default:
      return "❔";
  }
}
