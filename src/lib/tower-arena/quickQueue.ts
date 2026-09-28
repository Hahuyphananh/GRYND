// src/lib/tower-arena/quickQueue.ts
//
// Quick-queue destination for Tower Arena. Tower Arena is 1v1, so there is no
// seat count to negotiate: a queued candidate fills the next open waiting
// lobby with the same wager (or opens one), and the pairing worker's second
// call seats the opponent.
import { createOrJoinTowerArena } from "./serverStore";

export async function createOrJoinTowerArenaDestination({
  userId,
  wager = 10,
}: {
  userId: string;
  wager?: number;
}) {
  return createOrJoinTowerArena({ userId, wager });
}