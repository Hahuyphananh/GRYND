"use client";
import { useMemo, useState } from "react";
import NavigationBar from "../../components/navigation-bar";

export default function PoolMastersClient() {
  const [difficulty, setDifficulty] = useState("beginner");
  const [power, setPower] = useState(0.5);
  const accent = useMemo(() => difficulty === "hard" ? "#ff4dcb" : "#4de3ff", [difficulty]);
  return (
    <div className="rounded-2xl border p-5" style={{ borderColor: accent, boxShadow: `0 0 24px ${accent}66` }}>
      <NavigationBar currentPath="/casino" />
      <h2 className="text-2xl font-bold text-fuchsia-300">🎱 Pool Masters</h2>
      <p className="mt-2 text-sm text-cyan-100">Input-sync multiplayer: only shot vectors and final snapshots are networked.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <select className="rounded bg-black/40 p-2" value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
          <option value="beginner">AI Beginner</option><option value="medium">AI Medium</option><option value="hard">AI Hard</option>
        </select>
        <label className="text-sm">Shot power: {power.toFixed(2)}<input type="range" min={0.05} max={1} step={0.01} value={power} onChange={(e) => setPower(Number(e.target.value))} className="w-full"/></label>
      </div>
    </div>
  );
}
