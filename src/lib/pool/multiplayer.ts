import { SyncedState } from "./types";

export const isNewerVersion = (incoming: number, current: number) =>
  incoming > current;

export async function pushPoolState(
  matchId: string,
  state: SyncedState,
  aiMode: boolean,
) {
  if (aiMode) return;
  // Accept all lifecycle states — the API handles version-based dedup.
  // This ensures ROLLING states are persisted so the polling fallback
  // can show ball movement to the opponent in real time.

  fetch("/api/pool/update-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId, state }),
  }).catch(() => {});
}
