"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";

export default function TanksLobby() {
  const [wager, setWager] = useState(10);

  return (
    <div className="w-full h-screen bg-gradient-to-br from-gray-900 to-black flex flex-col items-center justify-center text-white p-6">
      <motion.div
        className="p-8 bg-gray-800/50 rounded-2xl shadow-2xl w-full max-w-md"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <h1 className="text-3xl font-bold mb-4 text-center">
          TANKS — Battle Lobby
        </h1>

        <div className="mb-4">
          <label className="text-sm text-gray-300">Your Bounty (Wager)</label>
          <input
            type="number"
            value={wager}
            onChange={(e) => setWager(Number(e.target.value))}
            className="w-full p-3 mt-1 rounded bg-black/30 border border-gray-700"
          />
        </div>

        <motion.div whileTap={{ scale: 0.96 }}>
          <Link
            href="/casino/tanks/game"
            className="block text-center w-full p-3 bg-green-600 hover:bg-green-700 rounded-xl font-bold cursor-pointer"
          >
            Start Game
          </Link>
        </motion.div>

        <div className="mt-6 text-center text-gray-400 text-sm">
          Kill players → steal their bounty.<br />Survive 5s to cash out.
        </div>
      </motion.div>
    </div>
  );
}
