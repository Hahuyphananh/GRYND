# Realtime Socket.IO Server

## Local development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure `realtime-server/.env`:
   ```env
   PORT=3001
   CLIENT_URL=http://localhost:3000
   CLERK_SECRET_KEY=your_clerk_secret_key
   ```
3. Run:
   ```bash
   npm run dev
   ```

## Production environment mapping

```env
# Frontend (Vercel Environment Variables)
NEXT_PUBLIC_SOCKET_URL=https://your-realtime-server.com

# Realtime server environment variables
CLIENT_URL=https://your-vercel-app.vercel.app
```

## Deployment rules

- Host this server separately from Next.js (Render, Railway, Fly.io, etc.).
- Do not deploy the Socket.IO server on Vercel.
- Keep secrets in deployment environment variables only.
