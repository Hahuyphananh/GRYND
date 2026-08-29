import { makeInitialMatch } from "./precision/matchmaking";
import { precisionLobbyStore, precisionMatchStore } from "./precision/serverStore";
import type { PrecisionPlayer } from "./precision/types";

export function createOrJoinPrecisionDestination({ userId, wager = 10, name = "Quick Queue Player" }) {
  const amount = Math.trunc(Number(wager));
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Invalid Precision wager", status: 400 };

  for (const [id, lobby] of precisionLobbyStore) {
    if (lobby.status !== "waiting" || lobby.gameMode !== "pvp" || lobby.wager !== amount || lobby.hostUserId === userId) continue;
    lobby.opponentUserId = userId;
    lobby.opponentName = name;
    lobby.status = "active";
    const players: PrecisionPlayer[] = [
      { seat: 1, userId: lobby.hostUserId, name: lobby.hostName || "Player 1", isReady: false, isConnected: true },
      { seat: 2, userId, name, isReady: false, isConnected: true },
    ];
    const match = makeInitialMatch(id, amount, players, "ready_up", 1);
    precisionMatchStore.set(id, match);
    return { match: { id }, joined: true };
  }

  const id = `quick-precision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  precisionLobbyStore.set(id, { id, hostUserId: userId, hostName: name, opponentUserId: null, opponentName: null, wager: amount, gameMode: "pvp", status: "waiting", createdAt: Date.now() });
  return { match: { id }, joined: false };
}
