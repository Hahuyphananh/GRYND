import { SyncedState } from "./types";

export const isNewerVersion = (incoming: number, current: number) =>
  incoming > current;

export async function pushPoolState(
  matchId: string,
  state: SyncedState,
  aiMode: boolean,
  force: boolean = false
) {
  if (aiMode) return;

  // ONLY save when shot is finished
  if (!force) return;

  await fetch("/api/pool/update-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matchId, state }),
  });
}
