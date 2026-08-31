// src/lib/tower-arena/quickQueue.ts
//
// Quick-queue destination for Tower Arena. Each queued candidate fills
// the next open waiting lobby with the same wager + seat count. Works for
// the existing 2-player pair path AND a future N-player group path
// (callers may invoke it once per candidate until the lobby is full; the
// lobby only starts once `maxPlayers` seats are funded).
import { createOrJoinTowerArena } from "./serverStore";

export async function createOrJoinTowerArenaDestination({
  userId,
  wager = 10,
  maxPlayers = 2,
}: {
  userId: string;
  wager?: number;
  maxPlayers?: number;
}) {
  return createOrJoinTowerArena({ userId, wager, maxPlayers });
}