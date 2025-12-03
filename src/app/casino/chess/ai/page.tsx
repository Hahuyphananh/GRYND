"use client";

import { Suspense } from "react";
import ChessAIPageInner from "../ai/ChessAIPageInner";

export default function ChessAIPage() {
  return (
    <Suspense fallback={<div className="text-white p-6">Loading...</div>}>
      <ChessAIPageInner />
    </Suspense>
  );
}
