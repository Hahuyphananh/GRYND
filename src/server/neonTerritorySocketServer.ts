import { createServer } from "http";
import { Server } from "socket.io";

export function startNeonTerritorySocketServer(port = 8080) {
  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: "*" } });

  io.on("connection", (socket) => {
    socket.on("match:join", ({ matchId }) => socket.join(`match:${matchId}`));
    socket.on("match:leave", ({ matchId }) => socket.leave(`match:${matchId}`));
    socket.on("action:submit", (payload) => io.to(`match:${payload.matchId}`).emit("turn:end", payload));
    socket.on("action:resign", ({ matchId, userId }) => io.to(`match:${matchId}`).emit("match:end", { winnerByResign: userId }));
  });

  httpServer.listen(port, () => {
    console.log(`Neon Territory socket server listening on :${port}`);
  });
}
