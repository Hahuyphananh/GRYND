"use client";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import NavigationBar from "../../../../../components/navigation-bar";

const ACTIONS = [
  {
    key: "SAFE_ROLL",
    name: "Safe Roll",
    desc: "Low risk attack: consistent small damage.",
  },
  {
    key: "POWER_ROLL",
    name: "Power Roll",
    desc: "High risk attack: big damage or self-hit.",
  },
  {
    key: "SHIELD",
    name: "Shield",
    desc: "Heals yourself and reduces incoming damage.",
  },
  {
    key: "DOUBLE_DOWN",
    name: "Double Down",
    desc: "All-in move: massive damage or heavy penalty.",
  },
];

function DiceFace({ value }: { value: number }) {
  const dots: Record<number, string[]> = {
    1: ["50% 50%"],
    2: ["30% 30%", "70% 70%"],
    3: ["30% 30%", "50% 50%", "70% 70%"],
    4: ["30% 30%", "70% 30%", "30% 70%", "70% 70%"],
    5: ["30% 30%", "70% 30%", "50% 50%", "30% 70%", "70% 70%"],
    6: ["30% 25%", "70% 25%", "30% 50%", "70% 50%", "30% 75%", "70% 75%"],
  };

  return (
    <div className="w-24 h-24 rounded-2xl bg-white border-4 border-cyan-400 relative shadow-2xl">
      {dots[value]?.map((pos, i) => {
        const [left, top] = pos.split(" ");
        return (
          <span
            key={i}
            className="absolute w-3 h-3 bg-black rounded-full -translate-x-1/2 -translate-y-1/2"
            style={{ left, top }}
          />
        );
      })}
    </div>
  );
}

export default function DiceDuelMatchPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const router = useRouter();

  const [match, setMatch] = useState<any>(null);
  const [turns, setTurns] = useState<any[]>([]);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [dice1, setDice1] = useState(1);
const [dice2, setDice2] = useState(0);
const [lastAction, setLastAction] = useState<string>("");
  const [rolling, setRolling] = useState(false);

  const [effect, setEffect] = useState("");
  const [showRules, setShowRules] = useState(false);
const [floatingText, setFloatingText] = useState<
  { id: number; text: string; side: "left" | "right" }[]
>([]);
const [endPopup, setEndPopup] = useState<null | "win" | "loss">(null);

const spawnFloat = (text: string, className: string, side: "left" | "right") => {
  const id = Date.now() + Math.random();

  setFloatingText((prev) => [
    ...prev,
    { id, text, className, side },
  ]);

  setTimeout(() => {
    setFloatingText((prev) => prev.filter((f) => f.id !== id));
  }, 900);
};

useEffect(() => {
  if (!match || !viewerId) return;

  if (match.status === "finished") {
    setEndPopup(match.winnerId === viewerId ? "win" : "loss");
  }
}, [match, viewerId]);

  const load = async () => {
    const res = await fetch(`/api/dice-duel/get-match?matchId=${matchId}`, {
      cache: "no-store",
    });

    const data = await res.json();
    if (!data.ok) return;

    setMatch(data.match);
    setTurns(data.turns || []);
    setViewerId(data.viewerId || null);
    if (data.match?.status === "finished") {
  setEndPopup(data.match.winnerId === data.viewerId ? "win" : "loss");
}
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 1500);
    return () => clearInterval(id);
  }, [matchId]);

  const activeMatchId = match?.id || matchId;

  const myTurn = useMemo(() => {
    return Boolean(
      match?.turnUserId &&
      viewerId &&
      match.turnUserId === viewerId
    );
  }, [match, viewerId]);

  const triggerEffect = (type: string) => {
    if (type === "SAFE_ROLL") setEffect("blue");
    if (type === "POWER_ROLL") setEffect("red");
    if (type === "SHIELD") setEffect("shield");
    if (type === "DOUBLE_DOWN") setEffect("gold");

    setTimeout(() => setEffect(""), 900);
  };

const rollDice = async (count: 1 | 2 = 1) => {
  setRolling(true);

  for (let i = 0; i < 12; i++) {
    const r1 = Math.floor(Math.random() * 6) + 1;
    const r2 = Math.floor(Math.random() * 6) + 1;

    setDice1(r1);
    setDice2(count === 2 ? r2 : 0);

    await new Promise((r) => setTimeout(r, 55));
  }

  const final1 = Math.floor(Math.random() * 6) + 1;
  const final2 = count === 2 ? Math.floor(Math.random() * 6) + 1 : 0;

  setDice1(final1);
  setDice2(final2);

  setRolling(false);

  return count === 2 ? final1 + final2 : final1;
};

const play = async (actionType: string) => {
  setPending(true);

  // 1. PLAYER TURN → ANIMATION FIRST
 const isTwoDice =
  actionType === "POWER_ROLL" || actionType === "DOUBLE_DOWN";

const total = await rollDice(isTwoDice ? 2 : 1);

setLastAction(
  `${prettyMove(actionType)} → rolled ${total}`
);

  const res = await fetch("/api/dice-duel/submit-turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId: activeMatchId, actionType }),
  });

triggerEffect(actionType);
  const data = await res.json();

// 🎯 PLAYER FLOATING FEEDBACK
const damage = data?.damageDealt ?? data?.damage ?? 0;

if (damage > 0) {
  spawnFloat(`-${damage}`, "text-fuchsia-400", "right");
}
  load();

  // 2. AI TURN DELAY + VISUAL SYNC
if (data.aiTurn) {
  setLastAction("AI thinking...");
  await sleep(800);

  setLastAction("AI is choosing move...");
  await sleep(600);

  const aiTwoDice =
    data?.actionType === "POWER_ROLL" ||
    data?.actionType === "DOUBLE_DOWN";

  const total = await rollDice(aiTwoDice ? 2 : 1);

  setLastAction(
    `AI Bot → ${prettyMove(data?.actionType || "Move")} (${total})`
  );

  triggerEffect(data?.actionType || "SAFE_ROLL");

  await sleep(500);

  await fetch("/api/dice-duel/ai-turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId: activeMatchId }),
  });

  await load();
}

  setPending(false);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const resign = async () => {
  await fetch("/api/dice-duel/resign", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ matchId: activeMatchId }),
  });

  // trigger loss popup instead of redirect
  setEndPopup("loss");
};

const prettyName = (id: string) => {
  if (!match) return "Loading...";

  if (id === match.player1Id) return match.player1Name || "Player 1";
  if (id === match.player2Id) return match.player2Name || "Player 2";

  return "Unknown";
};

  const prettyMove = (move: string) =>
    move
      .toLowerCase()
      .replace("_", " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="min-h-screen bg-[#050512] text-white p-4 md:p-8">
      <NavigationBar currentPath="/casino" />

      <div className="max-w-5xl mx-auto rounded-2xl border border-cyan-800 bg-black/30 p-5 mt-10">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-black text-fuchsia-400">
            Arena Match
          </h1>

          <div className="flex gap-2">
            <button
              onClick={resign}
              className="px-4 py-2 rounded bg-red-600 font-bold"
            >
              Resign
            </button>

            <button
              onClick={() => router.push("/casino/dice-duel")}
              className="text-cyan-300"
            >
              Back
            </button>
          </div>
        </div>

        {/* Dice */}
        <div className="mt-6 flex justify-center">
          <div
            className={`transition-all duration-150 ${
              rolling ? "rotate-[720deg] scale-125" : ""
            }`}
          >
            <div className={`flex items-center justify-center gap-3 ${dice2 > 0 ? "" : "w-full"}`}>
  <div className={`transition-all ${rolling ? "rotate-[720deg] scale-110" : ""}`}>
  <DiceFace value={dice1} />
</div>

 {dice2 > 0 && (
  <div className={`transition-all ${rolling ? "rotate-[720deg] scale-110" : ""}`}>
    <DiceFace value={dice2} />
  </div>
)}
</div>
<div className="mt-3 text-center text-cyan-300 font-bold">
  Total: {dice1 + dice2}
</div>
{lastAction && (
  <div className="mt-2 text-center text-sm text-slate-300">
    Last action: <span className="text-fuchsia-300">{lastAction}</span>
  </div>
)}
          </div>
        </div>

        {/* HP / Player Cards */}
<div className="grid md:grid-cols-2 gap-4 mt-6">

  {/* PLAYER */}
  <div className="relative rounded-xl border border-fuchsia-500 p-4">
    
    {floatingText
      .filter((f) => f.side === "left")
      .map((f) => (
        <div
          key={f.id}
          className="absolute -top-6 left-1/2 -translate-x-1/2 text-green-400 font-bold animate-bounce"
        >
          {f.text}
        </div>
      ))}

    <p className="text-sm text-fuchsia-300 font-bold">
      {match?.player1Id === viewerId
        ? match?.player1Name
        : match?.player2Name}
    </p>

    <p className="text-3xl font-bold">
      HP: {match?.hp1 ?? "--"}
    </p>
  </div>

  {/* ENEMY */}
  <div className="relative rounded-xl border border-cyan-500 p-4">

    {floatingText
      .filter((f) => f.side === "right")
      .map((f) => (
        <div
          key={f.id}
          className="absolute -top-6 left-1/2 -translate-x-1/2 text-red-400 font-bold animate-bounce"
        >
          {f.text}
        </div>
      ))}

    <p className="text-sm text-cyan-300 font-bold">
      {match?.player1Id === viewerId
        ? match?.player2Name
        : match?.player1Name}
    </p>

    <p className="text-3xl font-bold">
      HP: {match?.hp2 ?? "--"}
    </p>
  </div>

</div>

        {/* Status */}
        <div className="mt-4 text-sm text-slate-300">
          Round {match?.round || 1} ·{" "}
          {myTurn ? "Your Turn" : "Enemy Turn"}
        </div>

        {/* Buttons */}
        <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3">
  {ACTIONS.map((a) => (
    <button
      key={a.key}
      disabled={pending || !myTurn || match?.status !== "active"}
      onClick={() => play(a.key)}
      className="rounded-lg border border-pink-500 py-3 px-2 bg-[#140b2f] hover:bg-fuchsia-700 disabled:opacity-50 transition text-left"
    >
      <div className="font-bold text-white">{a.name}</div>
      <div className="text-xs text-slate-300 mt-1 leading-tight">
        {a.desc}
      </div>
    </button>
  ))}
</div>
<div className="mt-6 flex justify-center">
  <button
    onClick={() => setShowRules(!showRules)}
    className="px-4 py-2 rounded border border-cyan-500 text-cyan-300 hover:bg-cyan-500/20 transition"
  >
    {showRules ? "Hide Game Rules ▲" : "Show Game Rules ▼"}
  </button>
</div>
{showRules && (
  <div className="mt-4 rounded-xl border border-cyan-700 bg-black/40 p-5 text-sm text-slate-300 space-y-4">

    <h3 className="text-cyan-300 font-bold text-lg">
      Game Rules (Exact Mechanics)
    </h3>

    <div>
      <p>• Each player starts with <b>20 HP</b></p>
      <p>• Turn-based dice combat</p>
      <p>• Max 20 rounds</p>
      <p>• Reach 0 HP → lose</p>
    </div>

    <div className="pt-2 border-t border-slate-700">
      <h4 className="text-white font-semibold">🟦 Safe Roll (1 dice)</h4>
      <ul className="ml-5 list-disc">
        <li>1–2 → 0 damage</li>
        <li>3–4 → 2 damage</li>
        <li>5–6 → 4 damage</li>
      </ul>
    </div>

    <div className="pt-2 border-t border-slate-700">
      <h4 className="text-white font-semibold">🔥 Power Roll (2 dices)</h4>
      <ul className="ml-5 list-disc">
        <li>2–4 → take 3 damage</li>
        <li>5–7 → deal 3 damage</li>
        <li>8–10 → deal 6 damage</li>
        <li>11–12 → deal 8 damage</li>
      </ul>
    </div>

    <div className="pt-2 border-t border-slate-700">
      <h4 className="text-white font-semibold">🛡 Shield (1 dice)</h4>
      <ul className="ml-5 list-disc">
        <li>1–3 → heal 2 HP</li>
        <li>4–6 → heal 3 HP</li>
      </ul>
    </div>

    <div className="pt-2 border-t border-slate-700">
      <h4 className="text-white font-semibold">💥 Double Down (2 dices)</h4>
      <ul className="ml-5 list-disc">
        <li>2–7 → take 5 self damage</li>
        <li>8–12 → deal 10 damage</li>
      </ul>
    </div>

  </div>
)}
        {/* History */}
        <h2 className="mt-6 font-bold text-cyan-300">
          Battle History
        </h2>

        <div className="mt-2 space-y-2">
          {turns.map((t) => (
            <div
              key={t.id}
              className="text-sm rounded border border-slate-700 p-2"
            >
              <span className="text-white font-semibold">
                {prettyName(t.userId)}
              </span>{" "}
              used{" "}
              <span className="text-fuchsia-300">
                {prettyMove(t.actionType)}
              </span>{" "}
              • Damage {t.damageDealt} • Self {t.selfDamage}
            </div>
          ))}
        </div>
      </div>
      {endPopup && (
  <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
    <div
      className={`p-8 rounded-2xl text-center border-2 ${
        endPopup === "win"
          ? "border-green-400 shadow-[0_0_30px_#00ff88]"
          : "border-red-500 shadow-[0_0_30px_red]"
      } bg-[#0b0b1a]`}
    >
      <h1 className="text-4xl font-black mb-4">
        {endPopup === "win" ? "YOU WIN 🎉" : "YOU LOST 💀"}
      </h1>

      <p className="text-slate-300 mb-6">
        {endPopup === "win"
          ? "You dominated the arena!"
          : "Better luck next time..."}
      </p>

      <button
        onClick={() => router.push("/casino/dice-duel")}
        className="px-6 py-3 rounded bg-cyan-500 text-black font-bold"
      >
        Back to Lobby
      </button>
    </div>
  </div>
)}
    </div>
  );
}