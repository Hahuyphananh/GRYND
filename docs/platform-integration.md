# GRYND External Platform Integration — v1

Status: **foundation only.** These documents describe an integration contract GRYND
implements and tests in this repository. GRYND does **not** claim that it is
approved by, certified for, or compatible with any specific portal. Platform
policies (content rules, age gates, revenue share, required SDKs) differ and
must be reviewed per platform before launch.

---

## 1. What is supported

| Capability | Status |
|---|---|
| One embedded game: **Tic-Tac-Toe practice vs the bot** | Implemented, unrated |
| Server-to-server session mint with a per-platform secret | Implemented |
| Short-lived, origin- and game-scoped bearer sessions | Implemented (15 min) |
| Revocation / expiry | Implemented |
| postMessage lifecycle (ready, start, finished, expired, exit) | Implemented |
| Embedded Guest **PvP** (matchmaking, rooms, staked games) | **Not enabled** |
| Embedded account sign-in / Clerk inside the iframe | **Not supported** |
| Third-party cookies as the session mechanism | **Not used** — bearer token only |

Embedded play is always a guest practice record. It cannot enter matchmaking,
wagering, rating, trophies, rewards or account competition.

---

## 2. Required server configuration

All values live in GRYND's server environment. None are shipped to a browser.

```bash
# Comma-separated `platform=https-origin` allowlist. Both the server-side origin
# check and the CSP frame-ancestors policy for /embed/* are built from this list.
GRYND_PLATFORM_ALLOWLIST="exampleportal=https://games.example.com"

# Per-platform secret, at least 16 characters (use 32+ random bytes).
# The variable name is GRYND_PLATFORM_SECRET_<SLUG UPPERCASED>.
GRYND_PLATFORM_SECRET_EXAMPLEPORTAL=<server-only random secret>
```

A platform with no allowlist entry or no secret cannot mint sessions and cannot
frame the game. There is no wildcard fallback: with no configuration,
`frame-ancestors` stays `'self'`.

---

## 3. Launch sequence

```
Platform backend                      GRYND
      │  POST /api/platform/session      │
      │  Authorization: Bearer <secret>  │
      │  { platform, gameKey, origin }   │
      │─────────────────────────────────▶│
      │  201 { sessionToken, embedPath,  │
      │        expiresAt, ... }          │
      │◀─────────────────────────────────│
      │                                  │
      │  iframe src = embedPath          │
      │─────────────────────────────────▶│  validates token, expiry,
      │                                  │  revocation, platform, game, origin
```

### 3.1 Mint a session (server-to-server only)

```bash
curl -sS https://<grynd-host>/api/platform/session \
  -H "Authorization: Bearer $GRYND_PLATFORM_SECRET_EXAMPLEPORTAL" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "exampleportal",
    "gameKey": "tic-tac-toe",
    "origin": "https://games.example.com"
  }'
```

Response `201`:

```json
{
  "success": true,
  "data": {
    "sessionToken": "<opaque token>",
    "expiresAt": "2026-01-01T00:15:00.000Z",
    "platform": "exampleportal",
    "gameKey": "tic-tac-toe",
    "origin": "https://games.example.com",
    "embedPath": "/embed/exampleportal/tic-tac-toe?session=<opaque token>"
  }
}
```

- Send the secret **only** from your backend. Never put it in frontend code.
- The token is returned once. GRYND stores only its SHA-256 hash.
- Mint a new session when the previous one is within a few minutes of expiry.

### 3.2 Load the game

```html
<iframe
  id="grynd"
  src="https://<grynd-host>/embed/exampleportal/tic-tac-toe?session=<token>"
  title="GRYND Tic-Tac-Toe practice"
  allow="fullscreen"
  referrerpolicy="strict-origin-when-cross-origin"
></iframe>
```

Only `https://games.example.com` may frame this URL; the response's CSP
`frame-ancestors` is generated from `GRYND_PLATFORM_ALLOWLIST`.

### 3.3 Platform SDK (optional)

`/platform-sdk/grynd-platform-v1.js` is a small helper for the platform page:

```html
<script src="https://<grynd-host>/platform-sdk/grynd-platform-v1.js"></script>
<script>
  const grynd = GryndPlatformSDK.create({
    iframe: document.getElementById("grynd"),
    origin: "https://<grynd-host>", // the GRYND origin, explicit https
  });

  grynd.on("grynd:ready", () => grynd.start()); // or let the player press Play
  grynd.on("grynd:match_finished", (event) => {
    // unrated practice only; no rewards to grant
  });
  grynd.on("grynd:session_expired", () => {
    // mint a new session on your backend, then reload the iframe
  });
  grynd.on("grynd:exit", () => {
    // close the iframe / return to the platform lobby
  });
</script>
```

The SDK requires an explicit https origin, posts with that exact `targetOrigin`
(never `"*"`), and ignores messages from any other origin or envelope version.

---

## 4. postMessage contract

Envelope, both directions:

```json
{ "source": "grynd-platform", "version": 1, "type": "grynd:ready", "...": "..." }
```

| Direction | Type | Meaning |
|---|---|---|
| GRYND → platform | `grynd:ready` | Embed is loaded; includes `gameKey`, `platform` |
| GRYND → platform | `grynd:match_started` | Practice match created |
| GRYND → platform | `grynd:match_finished` | Match ended; practice only |
| GRYND → platform | `grynd:session_expired` | Token expired; mint a new session |
| GRYND → platform | `grynd:exit` | Player asked to return to the platform |
| GRYND → platform | `grynd:error` | Game-level error |
| platform → GRYND | `grynd:start` | Ask the game to start practice |
| platform → GRYND | `grynd:ping` | Liveness; answered with `grynd:ready` |

Rules:

- Each side validates `event.origin` exactly; substring matching is not enough.
- Unknown versions, sources and types are ignored.
- Outbound messages never use a wildcard target.
- No sensitive data (tokens, guest ids, account data) is sent over postMessage.

---

## 5. Session lifecycle

- **Lifetime:** 15 minutes from mint.
- **Expiry:** the embed stops accepting moves, shows a "session expired" state,
  and posts `grynd:session_expired`. Mint a new session and reload the iframe.
- **Revocation:** `POST /api/platform/session/end` with `Authorization: Bearer
  <sessionToken>` (or `{ "token": "…" }`). Idempotent.
- **Validation:** `POST /api/platform/session/validate` returns metadata only
  (platform, game, origin, expiry). It never returns the guest identity and
  never issues a new token.
- The guest identity behind an embedded session is server-minted and scoped to
  that session. It is **not** the browser's `grynd_guest` cookie, cannot be used
  to claim guest progression, and cannot become a Clerk account.

---

## 6. API access from the embed

The embedded client sends `Authorization: Bearer <sessionToken>` to:

- `POST /api/tic-tac-toe/create-ai`
- `GET  /api/tic-tac-toe/match/:matchId`
- `POST /api/tic-tac-toe/match/:matchId/move`

Those routes opt into platform sessions **for `tic-tac-toe` only**. A token
minted for another game is rejected. No account, wallet, matchmaking, PvP,
progression-claim or admin API accepts a platform token, and no CORS origin is
broadened for them.

---

## 7. Security requirements for the platform

1. Keep the platform secret on your server; rotate it by changing GRYND's env
   and your own in one coordinated step (mint fails closed during a mismatch).
2. Do not expose `sessionToken` in page HTML beyond the iframe URL you control,
   analytics, logs or error reports.
3. Frame only the exact origins returned by GRYND; never proxy the embed page
   through a different origin.
4. Validate `event.origin` in your own handlers even when using the SDK.
5. Do not attempt to use the embed to reach GRYND account features. There are
   none in an embedded session by design.

---

## 8. Verified requirements vs assumptions

**Verified in this repository (tests):** session mint/validation/expiry/
revocation, origin and game scoping, hashed tokens, exact-origin postMessage
validation, CSP `frame-ancestors` allowlist, `/embed` X-Frame-Options removal,
standalone headers unchanged, platform bearer accepted only by opted-in
Tic-Tac-Toe practice routes, no cookie use in embedded sessions.

**Assumptions / not implemented:** any specific portal's approval process,
required branded loader, ad or analytics SDK, age-verification handshake,
revenue reporting, leaderboard submission, or platform-hosted account linking.
None of those are claimed as supported here.

---

## 9. Known limitations

- One embedded game. The list is closed in `src/lib/platform/config.ts`.
- Practice only; embedded PvP and realtime Socket.IO are not enabled.
- If the platform blocks iframes or third-party storage entirely, the embed
  still works because it uses bearer tokens rather than cookies — but the
  platform must supply its own consent/age handling where required.
- Session tokens are bearer credentials: anyone who obtains one can play that
  session's practice game until expiry. They are short-lived and revocable, but
  they should still be treated as secrets in transit (HTTPS only).
- No automated cleanup job for expired `platform_sessions` rows yet; the expiry
  index is in place for one.
