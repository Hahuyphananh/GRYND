"use client";

import { useEffect, useState } from "react";

export function QuickQueueStatus({ refreshKey = 0 }) {
  const [state, setState] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/quick-queue/status", { cache: "no-store", credentials: "include" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { if (!cancelled && data?.success) setState(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (!state) return null;
  const assignment = state.assignment;
  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/70" role="status">
      <span className="font-semibold text-cyan-200">Quick Queue:</span>{" "}
      {assignment?.status === "ready"
        ? `Matched to ${assignment.gameKey}${assignment.destinationMatchId ? " — opening your match" : " — waiting for game entry"}.`
        : state.ready ? "Waiting across your selected games." : "Not active."}
    </div>
  );
}
