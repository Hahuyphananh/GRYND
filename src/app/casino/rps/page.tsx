"use client";
import { useEffect, useState, useRef } from "react";
import NavigationBar from "../../../components/navigation-bar";

const PVP_CHOICES = ["rock", "paper", "scissors"];

export default function RPSGame() {
  const [tokens, setTokens] = useState(0);
  const [betAmount, setBetAmount] = useState(10);
  const [playerChoice, setPlayerChoice] = useState<string | null>(null);
  const [aiChoice, setAiChoice] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
  const [pvpMyChoice, setPvpMyChoice] = useState<string | null>(null);
  const [pvpOpponentChoice, setPvpOpponentChoice] = useState<string | null>(null);
  const [pvpOutcome, setPvpOutcome] = useState<string | null>(null);
  const [pvpWinner, setPvpWinner] = useState<string | null>(null);
  const [pvpMessage, setPvpMessage] = useState<string>("");
  const [pvpActionLoading, setPvpActionLoading] = useState(false);

  const autoBetRef = useRef(autoBet);
  autoBetRef.current = autoBet;

  const choices = ["rock", "paper", "scissors"];

  useEffect(() => {
    fetch("/api/get-user-tokens", { method: "POST" })
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
        setPvpMyChoice(game.myChoice || null);
        setPvpOpponentChoice(game.opponentChoice || null);
        setPvpOutcome(game.outcome || null);
        setPvpWinner(game.winner || null);

        if (game.status === "active") {
          setPvpMessage("Waiting for opponent...");
        } else if (game.status === "matched" && !game.myChoice) {
          setPvpMessage("Opponent joined. Pick rock, paper, or scissors.");
        } else if (game.status === "matched" && game.myChoice && !game.opponentChoice) {
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

  const calculateMultiplier = (streak: number) => {
    if (streak <= 0) return 1.0;
    return 1.9;
  };

  const winStreakRef = useRef(winStreak);
  winStreakRef.current = winStreak;

  const multiplierRef = useRef(multiplier);
  multiplierRef.current = multiplier;

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      body: JSON.stringify({ betAmount, choice: playerChoice, winStreak: winStreakRef.current }),
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
        setPvpMyChoice(null);
        setPvpOpponentChoice(null);
        setPvpOutcome(null);
        setPvpWinner(null);
        setTokens(data.data.newBalance);
        setPvpMessage("Game created. Waiting for opponent...");
        fetchAvailablePvpGames();
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
        setPvpMyChoice(null);
        setPvpOpponentChoice(null);
        setPvpOutcome(null);
        setPvpWinner(null);
        setTokens(data.data.newBalance);
        setPvpMessage("Joined game. Pick your move.");
        fetchAvailablePvpGames();
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
        setPvpMyChoice(null);
        setPvpOpponentChoice(null);
        setPvpOutcome(null);
        setPvpWinner(null);
        setPvpMessage("Game cancelled");
        fetchAvailablePvpGames();
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

      <div className="w-full max-w-[380px] md:max-w-[380px] bg-[#002b55] rounded-xl p-6 flex flex-col gap-6 shadow-lg mx-auto md:mx-0 mb-6 md:mb-0">
        <h1 className="text-3xl font-bold text-yellow-400 text-center whitespace-nowrap mt-20">
          ✊ Rock Paper Scissors
        </h1>

        <p className="text-lg text-center md:text-left">Your Tokens: {tokens}</p>

        <div className="flex justify-center gap-4">
          <button
            onClick={() => setMode("pve")}
            className={`px-4 py-2 rounded font-bold ${
              mode === "pve" ? "bg-yellow-500 text-black" : "bg-gray-600"
            }`}
          >
            PvE
          </button>

          <button
            onClick={() => setMode("pvp")}
            className={`px-4 py-2 rounded font-bold ${
              mode === "pvp" ? "bg-yellow-500 text-black" : "bg-gray-600"
            }`}
          >
            PvP
          </button>
        </div>

        <div className="flex items-center justify-center gap-2">
          <label className="font-semibold">Bet:</label>
          <input
            type="number"
            min={1}
            max={tokens}
            value={betAmount}
            onChange={(e) => setBetAmount(Number(e.target.value))}
            className="text-black rounded px-2 py-1 w-20 text-center"
          />
          <span>tokens</span>
        </div>

        {mode === "pve" && (
          <>
            <button
              onClick={placeBet}
              disabled={loading}
              className="bg-gradient-to-b from-yellow-400 to-yellow-600 text-black px-6 py-3 rounded-xl font-bold shadow-lg hover:from-yellow-300 hover:to-yellow-500 disabled:opacity-50"
            >
              {loading ? "Betting..." : "Place Bet"}
            </button>

            <div className="mt-4 bg-[#001f3f] p-4 rounded-lg border border-yellow-400">
              <label className="flex items-center gap-2 font-semibold mb-2">
                <input
                  type="checkbox"
                  checked={autoBet.enabled}
                  onChange={(e) => {
                    if (
                      e.target.checked &&
                      (!playerChoice || betAmount <= 0 || betAmount > tokens)
                    ) {
                      alert("Select a valid choice and bet amount before enabling AutoBet.");
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
                    className="w-full rounded border border-yellow-400 bg-[#102542] px-2 py-1 text-center text-white"
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
                      className="w-full mt-2 rounded border border-yellow-400 bg-[#102542] px-2 py-1 text-center text-white"
                    />
                  )}

                  <button
                    onClick={() =>
                      setAutoBet({ enabled: false, mode: "finite", spinsLeft: 0 })
                    }
                    className="mt-2 w-full bg-red-600 hover:bg-red-700 text-white font-bold rounded px-4 py-2"
                  >
                    Stop AutoBet
                  </button>
                </>
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
                className="bg-green-600 hover:bg-green-700 px-6 py-3 rounded font-bold disabled:opacity-50"
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

            <div className="bg-[#001f3f] p-4 rounded-lg border border-blue-400">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-blue-200">Available Games</h3>
                <button
                  onClick={fetchAvailablePvpGames}
                  disabled={isLoadingPvpGames}
                  className="bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded text-sm font-semibold disabled:opacity-50"
                >
                  {isLoadingPvpGames ? "Refreshing..." : "Refresh"}
                </button>
              </div>
              {pvpGames.length === 0 ? (
                <p className="text-sm text-gray-300">No available games right now.</p>
              ) : (
                <ul className="space-y-2 max-h-48 overflow-auto pr-1">
                  {pvpGames.map((game) => (
                    <li
                      key={game.id}
                      className="bg-[#0d335f] rounded p-2 flex items-center justify-between gap-2"
                    >
                      <div className="text-sm">
                        <p className="font-semibold">Host: {game.player1Name || "Unknown"}</p>
                        <p>Bet: {game.betAmount}</p>
                      </div>
                      <button
                        onClick={() => joinPvpGame(game.id)}
                        disabled={pvpActionLoading || Boolean(pvpGameId)}
                        className="bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded text-sm font-semibold disabled:opacity-50"
                      >
                        Join
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {pvpMessage && <p className="text-sm text-yellow-200">{pvpMessage}</p>}
          </>
        )}
      </div>

      <main className="flex-1 flex flex-col items-center justify-center gap-8 ml-0 md:ml-6 w-full px-4 md:px-0">
        {mode === "pve" && (
          <>
            <div className="flex flex-col md:flex-row items-center gap-12">
              <div className="bg-[#002b55] border border-yellow-500 w-32 h-44 flex items-center justify-center rounded-xl text-6xl">
                {getEmoji(playerChoice)}
              </div>

              <div className="text-3xl font-bold text-yellow-400">VS</div>

              <div className="bg-[#002b55] border border-yellow-500 w-32 h-44 flex items-center justify-center rounded-xl text-6xl">
                {getEmoji(aiChoice)}
              </div>
            </div>

            {result && (
              <div
                className={`text-2xl font-bold ${
                  result === "win"
                    ? "text-green-400"
                    : result === "lose"
                    ? "text-red-400"
                    : "text-gray-400"
                }`}
              >
                {result.toUpperCase()}
              </div>
            )}

            <div className="flex gap-4 flex-wrap justify-center">
              {choices.map((choice) => (
                <button
                  key={choice}
                  onClick={() => setPlayerChoice(choice)}
                  className={`px-6 py-3 rounded-xl font-bold ${
                    playerChoice === choice
                      ? "bg-yellow-500 text-black"
                      : "bg-yellow-700 hover:bg-yellow-600 text-black"
                  }`}
                >
                  {choice}
                </button>
              ))}
            </div>

            <div className="text-center w-full max-w-[400px]">
              <p className="text-xl">
                <span className="text-yellow-400 font-bold">Win Streak:</span> {winStreak}
              </p>
              <p className="text-xl">
                <span className="text-yellow-400 font-bold">Multiplier:</span> {multiplier.toFixed(2)}×
              </p>
            </div>
          </>
        )}

        {mode === "pvp" && (
          <div className="w-full max-w-2xl flex flex-col items-center gap-4">
            <div className="flex items-center gap-8">
              <div className="bg-[#002b55] border border-blue-500 w-28 h-36 flex items-center justify-center rounded-xl text-5xl">
                {getEmoji(pvpMyChoice)}
              </div>
              <div className="text-3xl font-bold text-blue-300">VS</div>
              <div className="bg-[#002b55] border border-blue-500 w-28 h-36 flex items-center justify-center rounded-xl text-5xl">
                {pvpStatus === "finished" ? getEmoji(pvpOpponentChoice) : "❔"}
              </div>
            </div>

            {pvpGameId && (
              <p className="text-sm text-gray-300">Game ID: {pvpGameId}</p>
            )}

            {pvpStatus === "matched" && !pvpMyChoice && (
              <div className="flex gap-3 flex-wrap justify-center">
                {PVP_CHOICES.map((choice) => (
                  <button
                    key={choice}
                    onClick={() => choosePvpMove(choice)}
                    disabled={pvpActionLoading}
                    className="px-5 py-2 rounded-lg font-bold bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
                  >
                    {choice}
                  </button>
                ))}
              </div>
            )}

            {pvpStatus === "finished" && (
              <div className="text-center">
                <p className="text-xl font-bold text-yellow-300">Outcome: {pvpOutcome}</p>
                <p className="text-lg">
                  Result: {pvpWinner === "you" ? "You win" : pvpWinner === "opponent" ? "You lose" : "Tie"}
                </p>
              </div>
            )}

            {!pvpGameId && (
              <p className="text-yellow-300 font-semibold">Create or join a game to start PvP.</p>
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
