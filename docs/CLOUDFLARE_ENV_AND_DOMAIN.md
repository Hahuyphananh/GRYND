# Cloudflare environment variables & custom-domain cutover

How configuration is split on Cloudflare Workers (OpenNext) and how to serve
`https://grynd.dedyn.io` from the Worker while deSEC stays the authoritative DNS
provider.

---

## 1. Why two places: build-time vs runtime

`NEXT_PUBLIC_*` values are **inlined into the JavaScript bundle at build time**.
Every other variable is read from `process.env` **at runtime**. On Cloudflare
those are two different configuration surfaces, and putting a value in the wrong
one silently does nothing.

| | Where it must be set | Used for |
|---|---|---|
| `NEXT_PUBLIC_*` | Worker → **Settings → Build → Build variables and secrets** | inlined into the client + edge bundles by `next build` |
| everything else (secrets, server config) | `wrangler secret put NAME` or runtime **Environment variables** | read from `process.env` while the Worker runs |

`wrangler.jsonc` → `vars` is a **runtime** binding only. It does **not** feed the
build, so it can never inline a `NEXT_PUBLIC_*` value.

References: OpenNext *Env Vars* — "When you use Workers Builds to deploy your
application, the environment variables must be set in the *Build variables and
secrets*."

### Symptoms of a `NEXT_PUBLIC_*` value missing at build time

- **Blank sign-in page.** `src/app/providers.tsx` passes
  `process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` to `<ClerkProvider>`; if it was
  not inlined, Clerk has no key and the `<SignIn/>` UI never mounts.
- **Every game route redirects to `/complete-profile`.** The middleware age gate
  (`src/middleware.ts`) calls `edgeUserAge`, which reads
  `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in
  `src/lib/security/edgeFlags.ts`. With no Supabase URL the lookup returns
  "age unknown", and `if (!age)` sends the signed-in user to `/complete-profile`.

### The split for this app

**Workers BUILD variables** (public — safe to store as plain build vars):

```
NEXT_PUBLIC_BASE_URL                    = https://grynd.dedyn.io
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
NEXT_PUBLIC_SOCKET_URL                  = <render realtime URL>
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
NEXT_PUBLIC_POSTHOG_HOST
NEXT_PUBLIC_POSTHOG_KEY
NEXT_PUBLIC_ROLLBAR_GRYND_CLIENT_TOKEN_1789326910
```

**Runtime secrets** (`npx wrangler secret put <NAME>`, never committed):

```
ADMIN_TOTP_SECRET            CRON_SECRET
CLERK_SECRET_KEY             REALTIME_INTERNAL_SECRET
CLERK_WEBHOOK_SECRET         RESEND_API_KEY
DATABASE_URL                 RESEND_WEBHOOK_SECRET
GROQ_API_KEY                 ROLLBAR_GRYND_SERVER_TOKEN_1789326910
PM_API_KEY                   SMTP_PASS
POSTHOG_PERSONAL_API_KEY     STRIPE_SECRET_KEY
SUPABASE_SERVICE_ROLE_KEY    STRIPE_WEBHOOK_SECRET
YOUTUBE_CLIENT_SECRET
```

**Runtime non-secrets** (may live in `wrangler.jsonc` → `vars`):

```
CLERK_JWT_KEY (public half)  POSTHOG_PROJECT_ID
SMTP_HOST / SMTP_PORT        SMTP_SECURE / SMTP_TLS_INSECURE
SMTP_USER                    YOUTUBE_CLIENT_ID
```
`NEXT_PUBLIC_*` values are deliberately **not** committed to `wrangler.jsonc`:
a runtime var has no effect on them (Next inlines them at build), and the
pre-commit secret scanner flags the publishable keys. Keep them in Workers
Build variables only.

> Redeploy after changing build variables — a build must re-run to re-inline.

---

## 2. Database: Hyperdrive is **required** (Supabase's certificate)

The Worker cannot reach Supabase Postgres through `DATABASE_URL` at all, no matter
which Supabase endpoint the string points at. This is a platform limitation, not
a configuration mistake, and it is why the first Cloudflare deploy answered
`/api/health` with `db:"error"` and `/games` with 503.

**What actually happens.** Workers TCP sockets (`cloudflare:sockets`) *always*
validate the origin certificate and expose **no** `rejectUnauthorized` or
custom-CA option — on workerd, `node:tls` throws `The options.rejectUnauthorized
option is not implemented`. Supabase serves a chain rooted at its private
"Supabase Root 2021 CA", so the TLS handshake is rejected by the runtime.
`pg` then loses that error: `pg/lib/client.js` reports the generic
`Connection terminated unexpectedly` to the query whenever the socket ends while
connecting, which is what Drizzle logged.

Measured from inside the deployed Worker (raw `SSLRequest` → `'S'` → `startTls()`
replayed through `pg/lib/stream`, i.e. exactly pg's own path):

| endpoint | TCP open | `SSLRequest` reply | `startTls()` |
|---|---|---|---|
| `aws-1-us-east-2.pooler.supabase.com:6543` (configured) | yes | `S` | **`TLS Handshake Failed.`** |
| `db.<ref>.supabase.co:5432` (direct) | yes | `S` | **`TLS Handshake Failed.`** |

Both fail identically at the certificate check — the pooler-vs-direct choice and
SNI are *not* the cause, so switching `DATABASE_URL` to the direct string will
not help. Upstream reference: `porsager/postgres#1213`.

**The fix.** Bind Hyperdrive, which terminates the origin connection itself
(and handles the pooler/certificate problem). `src/db/pool.ts` prefers
`env.HYPERDRIVE.connectionString` whenever the binding is present.

```bash
# Supabase → Settings → Database → Connection string → Direct (port 5432).
# Do NOT use the pooled/transaction string (port 6543): Hyperdrive pools.
npx wrangler hyperdrive create grynd-supabase \
  --connection-string="postgres://postgres:<password>@db.<ref>.supabase.co:5432/postgres"
```

That command prints a config `id`; put it in `wrangler.jsonc`:

```jsonc
"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<id>" }]
```

Two notes that cost time if missed:

- **The Worker → Hyperdrive hop is deliberately not TLS.** Hyperdrive's
  connection string is an internal address that does not answer the Postgres
  `SSLRequest` negotiation, so `src/db/pool.ts` skips its `ssl` option for that
  path (Cloudflare's own example is `new Client({ connectionString })` with no
  `ssl`).
- `wrangler hyperdrive create` validates the connection **from Cloudflare's
  network**, so it works from a machine that blocks outbound 5432/6543.

`DATABASE_URL` stays set and remains the fallback for Vercel/Node (where
`rejectUnauthorized: false` does apply); it is simply unreachable from Workers.

### Connections on Workers: nothing is pooled (measured)

Even with Hyperdrive bound, a plain `pg.Pool` does not work on Workers.
`src/db/pool.ts` therefore uses a **connection per operation** on the Hyperdrive
path (`HyperdrivePool`), and a normal `Pool` everywhere else.

The failure it avoids: when a request stalls, workerd cancels it and takes its
async context with it, so pg-pool never gets the checked-out client back. Once
`_clients.length` reaches `max`, **every later query in that isolate** fails with
pg-pool's *check-out* timeout — `timeout exceeded when trying to connect` (line
224 of `pg-pool/index.js`; it is not a connect timeout, which is what makes it
misleading). One stalled request poisons the database for the whole isolate.

Measured on the deployed Worker, before the change:

| signal | value |
|---|---|
| `/api/health` returning 200 | 10/20 |
| tail outcomes | `exception` ("hung … would never generate a response") + `exceededCpu` |
| an 8-query burst | all 8 queries timed out after 5 s |
| a one-shot `Client` (no pool) | 6/6 reliable, 4-314 ms |
| short `idleTimeoutMillis` (50 ms) | no improvement — the stuck client is *checked out*, not idle |

After switching to a connection per operation: **20/20** `/api/health` → 200
`db:"ok"`, every drizzle probe and burst `ok`, 3-16 ms per query, and no
`exception`/`exceededCpu`/error logs in the tail. It is also what Cloudflare's
own pg + Hyperdrive example does ("create a client per request … fast and
recommended").

Two details in that class are load-bearing and must not be "simplified":

- The name includes `Pool` and `connect()` returns a client with `release()`,
  because `drizzle-orm/node-postgres` decides whether transactions are available
  by testing `constructor.name.includes("Pool")` and calling
  `client.release()` in its `finally`. This app uses `db.transaction()` widely.
- There is **no** `ssl` option on that hop: Hyperdrive's connection string
  carries `sslmode=disable`, and its endpoint answers "The server does not
  support SSL connections" to an SSLRequest (both verified on the Worker).

`wrangler.jsonc`'s `localConnectionString` is for local development only —
wrangler refuses to start `wrangler dev` / `opennextjs-cloudflare deploy`
(`getPlatformProxy` runs in local mode) without it. It must never hold the real
Supabase URL, since the file is committed.

---

## 3. Custom domain: `grynd.dedyn.io` on the Worker, deSEC authoritative

**The constraint.** Cloudflare Workers *Custom Domains* require the hostname's
zone to be **active on Cloudflare** ("you cannot create a Custom Domain … on a
zone you do not own"). `grynd.dedyn.io` lives under deSEC's `dedyn.io`, whose
nameservers you cannot change. So the hostname cannot be added as a plain Custom
Domain directly.

### Step 0 — try the simple path first

Worker → Settings → Domains & Routes → Add → Custom Domain → `grynd.dedyn.io`.
If Cloudflare accepts it and shows a DNS record, create that record at deSEC and
you are done. If it demands Cloudflare nameservers, use the Custom Hostnames flow
below.

### Step 1 — a fallback zone you control

Cloudflare for SaaS needs **one Cloudflare zone** to host the custom hostname.
Attach any domain whose nameservers you *can* move to Cloudflare (a separate
domain you own). Call it the **fallback zone**. This does **not** touch
`grynd.dedyn.io`.

### Step 2 — put the Worker on the fallback zone

On the fallback zone, attach the Worker to a hostname, e.g.:

```
origin.<fallback-zone>        (Worker → Settings → Domains & Routes → Custom Domain)
```

This hostname becomes the SaaS **fallback origin**.

### Step 3 — add the custom hostname

In the fallback zone: **SSL/TLS → Custom Hostnames → Add Custom Hostname**:

- Hostname: `grynd.dedyn.io`
- Validation: **TXT**
- Fallback origin: `origin.<fallback-zone>` (from Step 2)

### Step 4 — create the records deSEC shows

Cloudflare then displays the exact records to add. Typically:

```
_cf-custom-hostname.grynd.dedyn.io   TXT    <validation-token>
grynd.dedyn.io                       CNAME  origin.<fallback-zone>
```

Create both in the deSEC dashboard. (`grynd.dedyn.io` is a subdomain of
`dedyn.io`, not a zone apex, so a CNAME is allowed there.)

### Step 5 — validate and issue the certificate

Back in Cloudflare, refresh the custom hostname status. Once validation passes,
Cloudflare issues an **Advanced Certificate** for `grynd.dedyn.io` and routes
traffic to the Worker. Verify:

```bash
curl -sI https://grynd.dedyn.io/ | head -3
curl -s  https://grynd.dedyn.io/api/health
```

### Step 6 — `www` (optional)

Add `www.grynd.dedyn.io` as a second custom hostname, or add a Cloudflare
Redirect Rule to send it to the apex. Custom Hostnames match an exact hostname,
so both must be added if both should work.

### Step 7 — repoint everyone else

- **Vercel**: remove `grynd.dedyn.io` from Project → Settings → Domains.
- **deSEC**: remove the old records that pointed `grynd.dedyn.io` at Vercel.
- **Clerk**: add `https://grynd.dedyn.io` to allowed origins/redirect URLs;
  point the Clerk webhook at `https://grynd.dedyn.io/api/webhooks/clerk`.
- **Stripe**: point the webhook endpoint at
  `https://grynd.dedyn.io/api/webhooks/stripe`.
- **Render**: `CLIENT_URL=https://grynd.dedyn.io` and
  `NEXTJS_INTERNAL_URL=https://grynd.dedyn.io`.

> Check your account's Cloudflare for SaaS custom-hostname limit before starting.

---

## 4. Verifying a deploy

```bash
GRYND_URL=https://grynd.dedyn.io npm run verify:cloudflare
GRYND_URL=https://grynd.phananhalbert.workers.dev npm run verify:cloudflare
```

The script (`qa/cloudflare-verify.mjs`) checks that the public vars were inlined,
that `/api/health` reports the database as `ok`, that `/sign-in` renders Clerk's
UI, and that a game route does not force `/complete-profile`. Pass a signed-in
session to exercise the authenticated age gate:

```bash
GRYND_COOKIE='__session=...; __client_uat=...' npm run verify:cloudflare
```
