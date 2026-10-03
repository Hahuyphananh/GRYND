"use client";

import { Suspense } from "react";
import ChessAIPageInner from "../ai/ChessAIPageInner";
import PageSkeleton from "../../../../components/skeletons/PageSkeleton";

export default function ChessAIPage() {
  return (
    // Branded per-route skeleton (the chessboard chunk is heavy) instead of a
    // bare "Loading..." line — matches the splash screen and app/loading.tsx.
    <Suspense fallback={<PageSkeleton />}>
      <ChessAIPageInner />
    </Suspense>
  );
}
