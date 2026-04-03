# Realtime Socket.IO Server

Separate backend for realtime game messaging. This server does **not** contain casino/game logic.

## Events
- `join_game` - join a room by `gameId`
- `move` - relay move payload to other players in room
- `leave_game` - leave room
- `disconnect` - notify room peers when a player disconnects

## Environment variables
See `.env.example`.

Local:
- `PORT=3001`
- `CLIENT_URL=http://localhost:3000`
- `CLERK_SECRET_KEY=...` (recommended)

Production:
- `CLIENT_URL=https://your-vercel-app.vercel.app`

## Run
```bash
cd realtime-server
npm install
npm run dev
```
