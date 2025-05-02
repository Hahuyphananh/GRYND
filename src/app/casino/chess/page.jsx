"use client";
import Link from "next/link";

export default function ChessLobby() {
  const tables = [1, 5, 10, 20, 50, 100];

  return (
    <div className="min-h-screen bg-[#003366] text-white p-6 text-center">
      <h1 className="text-4xl font-bold text-[#FFD700] mb-8">♟️ Chess Tables</h1>
      <div className="flex flex-wrap justify-center gap-4">
        {tables.map(amount => (
          <Link
            key={amount}
            href={`/casino/chess/${amount}`}
            className="bg-[#FFD700] text-[#003366] px-6 py-4 rounded-lg text-xl font-semibold hover:bg-[#FFD700]/80"
          >
            ${amount} Table
          </Link>
        ))}
      </div>
    </div>
  );
}
