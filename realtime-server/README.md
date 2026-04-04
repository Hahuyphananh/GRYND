# Realtime Socket.IO Server (Standalone Service)

This folder is an independent Node.js realtime backend service.

## Run locally

1. Install dependencies in this folder only:
   ```bash
   cd realtime-server
   npm install
   ```
2. Configure environment variables in `realtime-server/.env`:
   ```env
   PORT=3001
   CLIENT_URL=http://localhost:3000
   CLERK_SECRET_KEY=your_clerk_secret_key
   ```
3. Start:
   ```bash
   npm run dev
   ```

## Required events

This server relays realtime events only (no game logic):
- `join_game`
- `move`
- `leave_game`
- `disconnect`

## Deployment

- Deploy this server separately from Next.js (Render, Railway, Fly.io, VPS, etc.).
- Do **not** deploy Socket.IO runtime on Vercel serverless routes.
- Configure env vars in your host dashboard:
  - `PORT`
  - `CLIENT_URL` (your Vercel frontend URL; supports comma-separated origins for preview + production)
  - `CLERK_SECRET_KEY`

### Render quick setup (monorepo)

If you connected the whole repo to Render, set:
- **Root Directory**: `realtime-server`
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Health Check Path**: `/health`

Or use the repository-level `render.yaml` file included at project root.
