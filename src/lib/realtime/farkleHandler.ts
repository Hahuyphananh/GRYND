type SocketLike = {
  emit: (event: string, payload: any) => void;
  to?: (room: string) => { emit: (event: string, payload: any) => void };
  join?: (room: string) => void;
  leave?: (room: string) => void;
};

/** Lightweight in-memory room tracking for Farkle realtime sync. */
const activePlayers = new Map<string, Set<string>>(); // roomId → Set<socketId>

export function registerGame(name: string, handler: any) {
  return { name, handler };
}

/**
 * Farkle realtime handler.
 *
 * The Farkle game uses DB-backed API routes for all game logic.
 * This handler provides realtime event forwarding for:
 *   - Room join/leave tracking
 *   - Game state update notifications
 *   - Opponent disconnect detection
 */
export function farkleHandler(
  socket: SocketLike & { id: string },
  ctx: { userId: string; username: string },
) {
  const userId = ctx.userId;
  const joinedRooms = new Set<string>();

  return {
    /** Player joins a Farkle game room for live updates. */
    farkle_join: ({ roomId }: { roomId: string }) => {
      if (!roomId) return;
      const rid = String(roomId);

      if (socket.join) socket.join(rid);
      joinedRooms.add(rid);

      if (!activePlayers.has(rid)) {
        activePlayers.set(rid, new Set());
      }
      activePlayers.get(rid)!.add(socket.id);

      // Notify the room that a player joined
      if (socket.to) {
        socket.to(rid).emit("farkle:player_joined", {
          roomId: rid,
          userId,
          username: ctx.username,
        });
      }

      // Request a state refresh from the polling client
      socket.emit("farkle:refresh_state", { roomId: rid });
    },

    /** Player leaves a Farkle game room. */
    farkle_leave: ({ roomId }: { roomId: string }) => {
      if (!roomId) return;
      const rid = String(roomId);

      if (socket.leave) socket.leave(rid);
      joinedRooms.delete(rid);

      const players = activePlayers.get(rid);
      if (players) {
        players.delete(socket.id);
        if (players.size === 0) activePlayers.delete(rid);
      }

      if (socket.to) {
        socket.to(rid).emit("farkle:player_left", {
          roomId: rid,
          userId,
          username: ctx.username,
        });
      }
    },

    /** Forward game state update to opponent. */
    farkle_state_update: ({ roomId }: { roomId: string }) => {
      if (!roomId) return;
      const rid = String(roomId);

      if (socket.to) {
        socket.to(rid).emit("farkle:state_changed", {
          roomId: rid,
          userId,
          timestamp: Date.now(),
        });
      }
    },

    /** Notify opponent of a turn action. */
    farkle_action: ({
      roomId,
      actionType,
    }: {
      roomId: string;
      actionType: string;
    }) => {
      if (!roomId) return;
      const rid = String(roomId);

      if (socket.to) {
        socket.to(rid).emit("farkle:opponent_action", {
          roomId: rid,
          userId,
          actionType,
          timestamp: Date.now(),
        });
      }
    },
  };
}

export const farkleRegistration = registerGame("farkle", farkleHandler);
