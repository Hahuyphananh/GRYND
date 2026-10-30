# GRYND versioned releases

A release-based deployment system for the GRYND app and realtime server, built to
be adopted **after** approval and staging validation, plus the GitHub Actions
workflow that builds and (when explicitly enabled) deploys it. Nothing in this
directory has touched production: no unit is installed, no service was
restarted, no release was activated, and `/home/ubuntu/GRYND` is unchanged. The
workflow defaults to **build only** and stops for approval before any deploy.

```
                 GitHub Actions (ubuntu-24.04-arm, isolated)
        ┌──────────────────────────────────────────────────────────┐
        │ clean checkout of a committed SHA                        │
        │ → production-fix gate (CA patch must be committed)       │
        │ → npm ci (app + realtime) → tests → next build           │
        │ → assemble app/ + realtime/ → release.json → verify      │
        │ → upload artifact                                        │
        └───────────────────────────┬──────────────────────────────┘
                                    │ rsync (deploy job, approval-gated)
                                    ▼
   /home/ubuntu/grynd/                                    ┌──────────────────┐
   ├── incoming/<id>/ ────────── verify ── rename ───────►│ releases/<id>/   │ immutable
   │                                                      │  app/            │ .next, public,
   │                                                      │  realtime/       │ server.js, deps
   │                                                      │  release.json    │ sha, buildId, …
   ├── env/app.env        (0600, outside releases)        └──────────────────┘
   ├── env/realtime.env   (0600, outside releases)
   ├── current  ──symlink──► releases/<id>   ◄── atomic swap (activation)
   ├── previous ──symlink──► releases/<id-1> ◄── last-known-good
   └── state/
       ├── active.json      which release is live + the health results that let it in
       ├── verified.json    release ids that passed the health gate here
       ├── deployments.json GitHub Actions run history (latest 50, written on the host)
       └── audit.jsonl      append-only: install, activation, rejection, revert, prune
```

Both systemd units start from `current/…` and read their environment from
`env/`. Activation swaps the pointer, restarts the units, and only then lets the
release stay.

---

## 1. Why the pointer works (compatibility, verified rather than assumed)

A symlink in front of a Next.js app is a claim, so each dependency was checked:

| Dependency | Finding | Consequence |
|---|---|---|
| systemd `WorkingDirectory=` | Resolved when the unit starts, not continuously | Swap **then** restart; a swap alone changes nothing for a running process |
| `next start` asset + build resolution | Reads `.next/`, `.next/BUILD_ID`, `.next/static` and `public/` from `process.cwd()` | Served files follow the pointer at process start (proved by the staging fixture, which serves a different `BUILD_ID` after each swap) |
| App code absolute paths | `grep -rn "/home/ubuntu" src scripts realtime-server/server.js` → no matches | Nothing pins the old checkout path |
| `next.config.js` | Uses `__dirname` only for `turbopack.root` | Resolves to the release directory the link points at; same files either way |
| realtime `dotenv` | `require("dotenv").config()` reads `.env` from **cwd** | Its variables move to `env/realtime.env` via `EnvironmentFile=`; a release that ships a `.env` is rejected at install |
| Next runtime writes | `.next/cache` (ISR/images) is written under cwd | Release dirs are immutable *by deployment*, not read-only on disk; only `.next/cache` is written |
| `.next/static` | Content-hashed chunks served from the active release only | Open tabs may 404 on a stale chunk after a swap; see below |
| `.next/standalone` | Not used; the app runs `next start` | An artifact containing `standalone/` is rejected |

`rename(2)` over an existing symlink is atomic on Linux. On Windows it returns
`EPERM`, so the swap falls back to unlink+rename and reports `atomic: false`;
that path exists for the staging simulation only, and every result record carries
the strategy used.

### Open browser tabs across a deploy

Next.js serves content-hashed chunks from `current/app/.next/static`. After a
swap, a tab that was opened on the previous build may request a chunk that no
longer exists under `current`; it receives a 404 until the tab reloads. Keeping
`previous/` does not help yet because Nginx has no fallback rule for it.

This is a known limitation of this phase, not something an activation can fix.
The safe future options are (a) an Nginx `try_files` fallback to
`previous/app/.next/static` for `/_next/static/*` misses, or (b) a client-side
reload-on-chunk-error handler. Both change production behaviour and need their
own review; neither is implemented here. The short restart during activation
already forces most clients to reconnect.

## 2. Release format

```
releases/20261025T143012Z-3f9c2ab/
├── app/
│   ├── .next/{BUILD_ID,static,build-manifest.json,…}
│   ├── public/
│   ├── package.json  package-lock.json  next.config.js
│   └── node_modules/                  production deps only (npm prune --omit=dev)
├── realtime/
│   ├── server.js  package.json  package-lock.json
│   └── node_modules/                  its own tree, as today
└── release.json
```

`release.json` (written by `deploy/build-manifest.mjs`, re-validated on the host):

```json
{
  "schema": 1,
  "releaseId": "20261025T143012Z-3f9c2ab",
  "commit": "<40-char sha>",
  "shortCommit": "3f9c2ab",
  "buildId": "<.next/BUILD_ID>",
  "createdAt": "2026-10-25T14:30:12.000Z",
  "builder": { "workflow": "release.yml", "runId": "…", "runner": "…", "arch": "arm64", "node": "22.x.y" },
  "productionFixes": { "caTrust": true, "verifiedBy": "deploy/verify-production-fixes.mjs" },
  "checks": { "build": "passed", "tests": "passed" },
  "realtime": { "hash": "sha256:…" },
  "artifact": { "hash": "sha256:…", "files": 24117, "bytes": 412345678 }
}
```

`artifact.hash` is a sha256 over every file in the release — app, `.next`,
`public`, dependencies and realtime — excluding only `release.json` itself and
`app/.next/cache`, the one directory the running app writes (ISR/image cache).
Without that exclusion a rollback target would fail its own re-verification
after running for a while. The checksum is computed once at build time and
re-derived on the host at install and again at activation, so a corrupt or
half-transferred upload cannot be started. `checks` is pipeline metadata
recorded after the gates ran; it never substitutes for them.

Rules the tool enforces at install and again at activation:

- the id is `<UTC stamp>-<commit>`; anything with a separator, `..` or an absolute
  path is rejected before a path is built from it;
- `commit`/`buildId`/arch/Node major must be internally consistent and match the host;
- `.next/BUILD_ID` must equal the manifest, the realtime tree is re-hashed, and
  the whole-artifact checksum is re-derived and compared (a tampered upload is
  refused — including a modified static asset or dependency file);
- no `.env*`, no `*.pem`/`*.key`, no `standalone/`;
- an existing release id is never overwritten (`ALREADY_INSTALLED`).

## 3. Activation and rollback

```
validate (id, manifest, completeness, arch/node, BUILD_ID, realtime hash, env files)
   → controller.assertReady()            ← a host that cannot restart refuses HERE
   → swap current (atomic)
   → restart app (+ realtime only if its tree hash changed)
   → health gate: GET /api/health and GET /health on 127.0.0.1, bounded + retried
        each body is validated: ok=true, and db=ok for the app. A 200 with an
        unhealthy database is a FAILURE, not a pass.
        pass → mark verified, move `previous`, write active.json, audit "ok"
        fail → swap back, restart, health-check the revert, audit "failed" + revert outcome
```

- **No client input anywhere.** The tool has no HTTP surface at all (a test asserts
  it opens no socket); releases are named only by validated id, never by path.
- **Rollback** is the same sequence with extra preconditions: target must be
  installed, intact, and in `state/verified.json`; `--confirm <same id>` and a
  non-empty `--reason` are required; the active release is refused. Every
  rejection is audited with actor, target sha, previous sha, reason, timestamp.
- **A failed rollback is reported as failed.** If the revert itself cannot restart
  or cannot pass its health gate, the result says so (`revert.error` /
  `revert.health.ok === false`) and the audit records it. No success message is
  printed for an unverified end state.
- **Migrations are never touched.** The tool contains no call to `db:migrate`,
  `drizzle-kit` or any SQL (a test enforces this). A `previous` release is only
  safe to run if its schema is backward compatible; that is a review decision.
- **Realtime restart suppression:** if the release's `realtime.hash` equals the
  active release's, the shared realtime process is left running (app-only deploy,
  no dropped sockets).
- **App/realtime compatibility:** both trees are packaged from the same commit,
  so an activation or rollback moves them together (unless the realtime tree is
  byte-identical). They are not independently versioned, and a rollback after a
  protocol change should be reviewed against realtime clients before it runs.

## 4. Service changes required (proposed, not installed)

| | today | after migration |
|---|---|---|
| app unit | `WorkingDirectory=/home/ubuntu/GRYND`, `npm start`, env from the checkout | `WorkingDirectory=/home/ubuntu/grynd/current/app`, `node …/next/dist/bin/next start -p 3000 -H 127.0.0.1`, `EnvironmentFile=/home/ubuntu/grynd/env/app.env` |
| realtime unit | `WorkingDirectory=/home/ubuntu/GRYND/realtime-server`, `.env` in that directory | `WorkingDirectory=/home/ubuntu/grynd/current/realtime`, `EnvironmentFile=/home/ubuntu/grynd/env/realtime.env` |
| environment | `.env.production` (app) and `realtime-server/.env` inside the checkout | two `0600` files under `grynd/env/`, managed independently of any release |
| nginx / DNS / TLS / firewall | — | **no change** |
| `sudoers` | — | one scoped line for the dedicated deploy account (see §9): `grynd-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart grynd-app.service, /usr/bin/systemctl restart grynd-realtime.service` (verify the `systemctl` path with `command -v systemctl`) |

Files: `deploy/systemd/grynd-app.service`, `deploy/systemd/grynd-realtime.service`.
Both use `ConditionPathExists=/home/ubuntu/grynd/current` so a missing pointer
means "do not start", not "start the wrong thing". Their `ExecStart` uses
`/usr/bin/node` as a placeholder — set it to `command -v node` on the VM
(a version-managed Node install is not in `/usr/bin`).

Two operational notes for the units:

- `.next/cache` is written at runtime, so `ReadWritePaths=/home/ubuntu/grynd` is
  required under `ProtectSystem=full`;
- run `systemd-analyze verify` and a staging start before enabling them.

## 5. Staging validation

`deploy/staging/simulate.mjs` builds fixture releases in an OS temp directory and
drives the real modules and the real CLI. It never reads `/home/ubuntu`, never
touches a unit and never binds a privileged port.

```bash
node deploy/staging/simulate.mjs      # 49 checks
node --test deploy/tests/*.test.mjs   # 120 tests
npm run lint:release                  # release tooling lint
npm run typecheck                     # application type check
```

Results on this workstation (Windows, Node 24): **49/49 simulation checks,
119/120 deploy tests** (the 120th is a `chmod` assertion that cannot run on
Windows), `lint:release` clean. The build-side chain was exercised the same way — a fixture
artifact with no manifest, then `build-manifest.mjs`, then
`verify-artifact.mjs` — and re-running the verifier after editing one byte of
`realtime/` was rejected on the hash mismatch, so the tamper gate is proven, not
assumed.

The simulation covers: release creation and install; env handling without
printing values; the atomic pointer and a re-resolved `BUILD_ID` served by a real
child process; static assets served from the active release; realtime marker
resolved from `current/realtime`; a second activation moving `previous`;
an unhealthy release failing its gate and **reverting automatically**; rollback
with actor/sha/reason recorded; five refusal contracts through the CLI
(no reason, wrong `--confirm`, path-as-id, never-verified target, already active);
artifact gates (tampered `BUILD_ID`, realtime hash mismatch, tampered app file,
`.env` in artifact, wrong architecture, missing CA assertion); retention that never deletes the
active or previous release; environment files reported by size/mode only; and the
refusal to activate on a host with no service controller.

On the production host (Linux, Node 22.23.4, arm64) the same two commands report
**149/149** deploy tests and **49/49** simulation checks, with `lint:release` and
`typecheck` clean. A Windows working tree with `core.autocrlf=true` checks out
`.github/workflows/release.yml` with CRLF, which trips two LF-anchored policy
assertions locally; CI checks out the committed blob as LF. Check out with
`core.autocrlf=false` before treating a red suite as a real failure.

What the simulation deliberately does **not** claim:

- it does not build the real Next.js app (runs on the CI runner, not here);
- it cannot exercise systemd, nginx or a real Postgres, so the unit files are
  validated structurally, not started;
- the Windows swap path is non-atomic by construction; production uses the POSIX
  `symlink`+`rename` branch, which the unit tests cover separately;
- it does not run the Control Center; its release collector has its own tests in
  that repository, against in-memory fixtures.

Staging VM checklist (must pass before migration approval):

1. `uname -m` and `node -v` → set `RELEASE_ARCH` / confirm the Node major used by the workflow.
2. Install the two units with `ExecStart` pointing at the real `node`, plus the sudoers line.
3. Copy `.env.production` → `grynd/env/app.env` and `realtime-server/.env` → `grynd/env/realtime.env`, both `chmod 600`, then `node deploy/release.mjs env`.
4. Run one release through `install` + `activate` with `--controller=systemd --allow-systemd`, and confirm `/api/health`, a static asset, a socket connection and a game page.
5. Activate a deliberately broken build; confirm the automatic revert, the audit entry and that the site never served it.
6. Roll back to the previous release; confirm the recorded actor/shas and that no rebuild happened.
7. `prune --keep 3` and confirm the active and previous releases survive.

## 6. Failure modes

| Failure | What happens | What the operator sees |
|---|---|---|
| Build/test failure in CI | No artifact; nothing uploaded | Red workflow run |
| Commit lacks the CA fix | Job stops before install/build | `FAIL prod-ca-trust` with the offending file |
| Dirty tree | Job stops before install | `working tree is dirty` |
| Wrong runner architecture | Job stops before install | `runner is x64 but releases must be built for arm64` |
| Upload interrupted | `incoming/<id>` incomplete | `install` refuses (`RELEASE_UNUSABLE`); nothing in `releases/` |
| Artifact tampered in transit | Hash/BUILD_ID mismatch | `install` refuses, upload left in `incoming/` for inspection |
| Duplicate id | Refused | `ALREADY_INSTALLED`; releases are immutable |
| Pointer swap fails | Audit entry, no restart | `POINTER_SWAP_FAILED` |
| Restart fails | Pointer reverted, revert attempt recorded | `stage: service-restart`, `revert.error` |
| New release unhealthy | Pointer reverted, release unmarked | `stage: health`, health table, `revert` outcome |
| Revert also unhealthy | Reported, not hidden | `revert health gate FAILED` + "investigate before retrying" |
| DB down during activation | Health gate fails (503) and reverts | `db: "error"` recorded; this is a false negative for the release, and the safe direction |
| 200 but `db` unhealthy | Body validation fails the gate and reverts | `body reported db="error"`; a reachable proxy cannot hide a dead database |
| Rollback target missing/unverified | Refused, audited | `NOT_INSTALLED` / `NOT_VERIFIED` |
| Disk pressure | `install` rename fails cleanly | Error; prune with `--keep 3` |
| Host without units/sudoers | Activation refused before any swap | `No service controller is enabled` |

## 7. Migration plan (preserves the running site)

Each step is separately approvable and reversible; the live checkout is not
modified until step 5, and step 7 only happens after a verified release is live.

| # | Step | Effect on the live site | Reversible by |
|---|---|---|---|
| 0 | Merge `deploy/`, `.github/workflows/release.yml` | none | revert commit |
| 1 | Commit the CA patch and the lockfile repair (production's current content) | none | revert commit — **required before any release can build** |
| 2 | Create the dedicated `grynd-deploy` account/key and scoped sudoers rule; set repo variables and `grynd-production` environment secrets (see §9) | none | delete the account/key and variables |
| 3 | Run the workflow with `deploy: false`; verify the artifact on a staging VM | none | discard artifact |
| 4 | Create `/home/ubuntu/grynd/{releases,incoming,env,state,tool}`, copy the two env files in as `0600`, install the tool at `grynd/tool/` (§9.1 has ownership/modes) | none (nothing reads these yet) | `rm -rf /home/ubuntu/grynd` |
| 5 | Build the release for the live commit and `install` it (no activation) | none | delete `releases/<id>` |
| 6 | Stop both units, install the new unit definitions, `daemon-reload`, start | short, planned outage (seconds) | restore the previous unit files from `/etc/systemd/system/*.bak` and start |
| 7 | `activate <id>` on the new units | release goes live; health-gated | `rollback <previous-id>` (no rebuild) |
| 8 | Point the dashboard's `CC_RELEASE_ROOT` at the new root (read-only ACLs, no sudo) | none | unset the variable |
| 9 | After a quiet period, `prune --keep 3`; keep `/home/ubuntu/GRYND` for one more cycle | none | n/a |

Rollback of the migration itself (steps 6–7) is still possible the old way:
reinstall the original units pointing at `/home/ubuntu/GRYND`, `daemon-reload`,
start. That path is untouched by this phase.

## 8. Control Center integration (read-only)

The existing private dashboard (`grynd-control-center`, a separate Fastify app)
has a Deployments page that now reads this layout directly:
`state/active.json`, `state/verified.json`, the audit tail, the pointers and each
release's `release.json` + `BUILD_ID`, under `CC_RELEASE_ROOT` (default
`/home/ubuntu/grynd`). It displays the active release, commit, BUILD_ID, creation
and activation times, the most recent health-gate result, the previous
known-good release, history and rollback eligibility.

The Deployments page has **no write path**: no activation, no rollback, no
restart, no shell. Service restarts exist only through the separate operations
broker in §8.1, which ships disabled. This page never reads `env/`. Eligibility
is a statement about recorded metadata; the CLI still requires `--confirm <id>`
and a reason. An absent root renders "Not configured" and an empty one "No
release metadata available" — the dashboard does not infer a release from git.

The Deployments page also reads `state/deployments.json`, written by the deploy
job on the host. It shows the latest workflow run (run id, commit, release id,
BUILD_ID, build time, duration, health gate, rollback result) and the newest 20
runs in a history table. The record is a strict whitelist: unknown fields,
tokens, SSH keys and host names are dropped before the file is written, and a
test asserts they never reach the page. Building runs that never reach the
deploy job are visible in GitHub, not in the dashboard.

### 8.1 Restricted operations (Phase 6) — implemented, NOT enabled

`deploy/ops.mjs` and `deploy/lib/ops/` add a fixed, allowlisted operation broker
for the dashboard: restart `grynd-app.service`, restart `grynd-realtime.service`,
and nothing else. It has **no HTTP surface** — the dashboard spawns it, writes
one JSON request to stdin and reads one JSON response — so there is no new port,
no new route and no new authentication surface to review.

It is **inert by default**: `apply` refuses with `OPS_DISABLED` unless the host
sets `GRYND_OPS_ENABLED=1`, and no sudoers rule for it has been installed.

Before anything else, read **[ops-permissions.md](./ops-permissions.md)** — it is
the permissions matrix this phase is gated on, and it lists one open decision
(how configuration values are validated without the dashboard account being able
to read them) that needs your answer.

```bash
node deploy/ops.mjs status                          # units, active release, config summary
node deploy/ops.mjs config                          # presence, modes, key verdicts — no values
node deploy/ops.mjs backup                          # backup readiness; exists vs restore-verified
node deploy/ops.mjs plan restart.app --actor=ops     # impact + phrase + 2-minute token
node deploy/ops.mjs apply restart.app --token=… --confirm "restart grynd-app.service" \
     --reason="…" --actor=ops
node deploy/ops.mjs audit --limit 20
node deploy/ops.mjs audit-verify
```

Rules this phase enforces in code, not convention: the argv is a frozen array
(re-checked immediately before spawn), the token is HMAC-signed and single-use
and bound to one operation and one actor, a reason is mandatory and recorded,
the command has a hard timeout, and the result is verified against unit state and
the loopback health gate before it is called a success. Nothing restarts because
a metric looks unhealthy.

## 9. GitHub Actions deployment (Phase 5)

`.github/workflows/release.yml` is the reviewed pipeline. It is deliberately
split so that building is safe and deployment is separate:

- **Triggers:** push to `main`, or `workflow_dispatch` with `deploy` (default
  `false`). A manual dispatch also accepts `reason` and `allow_out_of_order`.
- **Push deployments are off by default.** A push only builds unless the
  repository variable `GRYND_DEPLOY_ENABLED` is exactly `"true"`.
- **No overlapping activation.** The deploy job uses concurrency group
  `grynd-production-deploy` with `cancel-in-progress: false`, so runs serialize.
- **Old runs cannot overwrite newer releases.** Preflight compares the built
  commit with `main`; immediately before activation the deploy job compares it
  with `main` again *and* with the active release. `ahead`, `behind`, `diverged`
  or `unavailable` fail closed. `workflow_dispatch` + `allow_out_of_order` is the
  only bypass, and it is still behind the environment approval.
- **Fail closed.** Every build step is a plain `run` with `set -euo pipefail`;
  there is no `continue-on-error` anywhere in this workflow. The artifact is
  verified before upload, after download, and again on the host before install
  and before activation.
- **No command is built from untrusted text.** A commit message, PR body, branch
  name or dispatch input is never interpolated into a shell command. The reason
  is passed through an environment variable and JSON; the host operation is one
  fixed script (`deploy/ci-deploy.mjs`) reading a JSON request on stdin.

### 9.1 Host identity and permissions (create once)

Use a dedicated, unprivileged account. Do not add the interactive
administrator's key, and do not allow root SSH.

```bash
# 1. On the trusted workstation: create a dedicated key for Actions.
#    Protect the private key; it goes only into the `grynd-production`
#    environment (note the leading `grynd-`: see §9.2).
ssh-keygen -t ed25519 -a 100 -f ~/.ssh/grynd-actions-deploy -C "grynd-actions-deploy"

# 2. On the host: create the service account and its key directory.
sudo useradd --system --create-home --shell /bin/bash grynd-deploy
sudo install -d -m 700 -o grynd-deploy -g grynd-deploy /home/grynd-deploy/.ssh
sudo install -m 600 -o grynd-deploy -g grynd-deploy \
  /dev/null /home/grynd-deploy/.ssh/authorized_keys

# 3. Append the PUBLIC key, restricted to non-forwarding sessions.
#    Replace <PUBLIC_KEY_BASE64> with the base64 key from grynd-actions-deploy.pub.
echo 'restrict ssh-ed25519 <PUBLIC_KEY_BASE64> grynd-actions-deploy' \
  | sudo tee -a /home/grynd-deploy/.ssh/authorized_keys

# 4. Scoped privilege only: restart the two units, nothing else.
#    Verify the systemctl path first with: command -v systemctl
sudo tee /etc/sudoers.d/grynd-deploy >/dev/null <<'EOF'
grynd-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart grynd-app.service, /usr/bin/systemctl restart grynd-realtime.service
EOF
sudo chmod 0440 /etc/sudoers.d/grynd-deploy
sudo visudo -cf /etc/sudoers.d/grynd-deploy

# 5. Release root owned by the deploy account; units run as ubuntu.
#    grynd-deploy must be able to traverse /home/ubuntu (normally 0755).
sudo install -d -m 755 -o grynd-deploy -g grynd-deploy /home/ubuntu/grynd
sudo install -d -m 755 -o grynd-deploy -g grynd-deploy \
  /home/ubuntu/grynd/{releases,incoming,state,tool}
# env/ holds the 0600 files owned by the service account; the directory itself
# is traversable so the deploy account can stat them (contents are never read).
sudo install -d -m 755 -o ubuntu -g ubuntu /home/ubuntu/grynd/env
```

Give the read-only dashboard access with an ACL (adjust `grynd-cc` to the
account from `INSTALL.md`):

```bash
sudo setfacl -R -m u:grynd-cc:rX /home/ubuntu/grynd/releases /home/ubuntu/grynd/state
sudo setfacl -R -d -m u:grynd-cc:rX /home/ubuntu/grynd/releases /home/ubuntu/grynd/state
sudo setfacl -m u:grynd-cc:rX /home/ubuntu/grynd /home/ubuntu/grynd/current /home/ubuntu/grynd/previous
```

No root login, no unrestricted sudo, no dashboard write path. The host-side
runner still requires `GRYND_ALLOW_SERVICE_RESTART=1` and its own systemd
controller check, so an accidental invocation cannot bounce production.

### 9.2 GitHub configuration (names only — never paste values here)

**Repository → Settings → Secrets and variables → Actions → Variables**

| Variable | Placeholder / default | Purpose |
|---|---|---|
| `RELEASE_RUNNER` | `ubuntu-24.04-arm` | Runner matching the VM architecture |
| `RELEASE_ARCH` | `arm64` | Asserted against `process.arch` in the build |
| `DEPLOY_HOST` | the instance's public IP (`155.248.226.196`) | SSH target; no scheme, no path |
| `DEPLOY_USER` | `grynd-deploy` | Dedicated deploy account |
| `DEPLOY_PORT` | `22` | SSH port |
| `DEPLOY_PATH` | `/home/ubuntu/grynd` | Release root on the host |
| `GRYND_DEPLOY_ENABLED` | **leave unset** | `"true"` enables push-to-main deployment |

**Repository variables (public build config, one per value):**
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`, `NEXT_PUBLIC_POSTHOG_KEY`,
`NEXT_PUBLIC_POSTHOG_HOST`, `NEXT_PUBLIC_SOCKET_URL`, `NEXT_PUBLIC_BASE_URL`,
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.

`next build` inlines every `NEXT_PUBLIC_*` the code reads, so each one has to be
in the build environment: built without them the artifact carries an empty Clerk
publishable key (every page renders with an unconfigured ClerkProvider), no
realtime socket URL (browser sockets never connect) and no analytics. They are
browser-visible by construction, which is why they are variables rather than
secrets. Their values mirror the production `.env.production`.

**Repository secrets (build only):** `CLERK_SECRET_KEY`, `SENTRY_AUTH_TOKEN`
(optional). The build job never receives a deploy key or host key; a policy test
enforces that. `CLERK_SECRET_KEY` is read at runtime from
`/home/ubuntu/grynd/env/app.env`, so it is only needed at build time if a
build-time Clerk call requires it.

**Environment `grynd-production`** (Settings → Environments → New environment).
The name is deliberately not `production`: this repository also carries a
`Production` environment from the Vercel integration, and a deploy must not
depend on how GitHub resolves two names that differ only in case. The workflow
names `grynd-production` and nothing else:

1. Add **required reviewers** (at least one; two for the first live release).
2. Restrict **deployment branches** to `main`.
3. Add environment secrets `DEPLOY_SSH_KEY` (the private key generated above)
   and `DEPLOY_KNOWN_HOSTS`.

The configured state is: required reviewers = the repository owner, deployment
branches = `main` only, `prevent_self_review` off (a single-owner repository
must be able to approve its own deployment; turn it on once a second reviewer
exists), and both secrets stored on this environment alone. Only this
environment is protected — `Preview` and `Production` are left exactly as they
were.

`DEPLOY_KNOWN_HOSTS` is the host's public key in `known_hosts` format, obtained
from the host console and verified out of band — not with `ssh-keyscan` in CI:

```
[<PRODUCTION_HOSTNAME>]:22 ssh-ed25519 <HOST_PUBLIC_KEY>
```

Get it on the host with `sudo cat /etc/ssh/ssh_host_ed25519_key.pub`; confirm the
fingerprint (`ssh-keygen -lf`) against the provider's console before saving it.
The workflow refuses to start if this entry is missing for `DEPLOY_HOST` and
`DEPLOY_PORT`, and `StrictHostKeyChecking=yes` is always in effect.

Store **two** lines for the same key:

```
<HOST> <KEYTYPE> <HOST_PUBLIC_KEY>
[<HOST>]:<PORT> <KEYTYPE> <HOST_PUBLIC_KEY>
```

With the default port 22 the client looks the host up under its bare name, so a
file holding only the bracketed form passes this pre-check and then fails the
connection with `No ED25519 host key is known for <host> and you have requested
strict checking`. Both forms name the same key, so nothing wider is trusted.

### 9.3 Deployment sequence

1. Build and test on the isolated runner; every required gate must pass.
2. Upload the immutable artifact and record its manifest checksum.
3. Download it in the deploy job and re-verify the checksum, BUILD_ID and
   realtime hash.
4. Compare the target with `main` and the active release (preflight + guard).
5. Refresh the reviewed tooling under `tool/`, then rsync the application
   artifact **only** into `incoming/<release-id>/`. The tooling runs as
   `grynd-deploy`; its only elevated operation is the two-unit restart rule. That
   rsync rewrites `lib/` (its own `--delete` applies inside that directory),
   `release.mjs`, `ci-deploy.mjs` and `record-deployment.mjs`, and does not remove
   anything else already in `tool/`: the first live deploy refreshed exactly those
   four paths and left `ops.mjs`, the verifiers, `systemd/` and `units/` untouched.
6. `install` verifies it again and renames it to `releases/<release-id>/`; an
   existing id is never overwritten.
7. Activation checks the env files by existence/mode/location (never contents),
   swaps `current` atomically, restarts the units, and runs the app + realtime
   health gates.
8. On success, `active.json`, `verified.json`, the audit log and
   `state/deployments.json` are written.
9. On a failed health gate or restart, the previous release is restored and its
   health is re-checked; the record carries the revert result and the run fails.

The live release is untouched until step 7. No migrations, DNS, Nginx, TLS,
firewall or production env file is changed by the workflow.

### 9.4 First rollout — build only, then staging, then approval

1. Leave `GRYND_DEPLOY_ENABLED` unset. A push to `main` builds an artifact and
   stops; it cannot deploy.
2. Run **Actions → release → Run workflow** with `deploy: false`. Confirm the
   artifact and manifest in the run summary.
3. Validate the artifact on a **staging VM** with the Phase 4 sequence (install,
   activate with the systemd controller, health checks, rollback).
4. `node deploy/staging/simulate.mjs` runs as part of the build and must report
   `49/49`; it is the non-production simulation for hosts without a staging VM.
5. Only after that sign-off, a manual dispatch with `deploy: true` pauses at the
   `grynd-production` environment for reviewer approval. Keep
   `GRYND_DEPLOY_ENABLED` unset until the first live release has been observed.

**Stop here before the first real production deployment.** This phase does not
activate anything; the workflow is inert for push-to-main until you set the
variable and approve a run.

## 10. What still needs your decision

1. **The CA patch is committed; the bundle still has to be installed on the
   host.** The gate now passes against `main` — `ok prod-ca-trust
   (src/db/pool.ts)` — so the build is no longer blocked by it. What remains is
   host-side and untestable from here: the pool verifies non-local TLS against a
   root CA that must exist at `/home/ubuntu/grynd/env/db-ca.pem` and be named by
   `DATABASE_SSL_CA_PATH` in `grynd/env/app.env`. Until it is, the app fails
   closed (a refused connection) rather than connecting unverified. The bundle
   belongs in `grynd/env/`, not in a release; certificates inside an artifact
   are rejected. How to obtain and install it: `docs/SUPABASE_MIGRATION.md` →
   "Verifying the database certificate".
2. **Architecture and Node version.** The workflow defaults to
   `ubuntu-24.04-arm` / `arm64`, and the installer refuses an artifact whose arch
   or Node major differs from the host. Confirm both on the VM before the first
   build; I could not SSH in from here (key auth refused), so nothing is assumed.
3. **Artifact size.** The app's `node_modules` is shipped to keep the VM free of
   installs. Measure with `du -sh` on the first build; retention of 3 releases is
   the default precisely to bound disk use.
4. **Do not enable the deploy job** (`deploy: true`) until step 5 of the migration
   plan has passed: it requires the units, the sudoers line and
   `GRYND_ALLOW_SERVICE_RESTART=1`, none of which exist yet.
5. **The repository test suite is red on `main`.** Running `npm test` reports
   `579` passing and `2` failing tests in `tests/countdown-start-liveness.test.mjs`
   (Precision and Keno countdown reads). They are unrelated to this deployment
   work, but the workflow runs `npm test` as a required gate, so it will fail
   closed until they are fixed. The build also stops at the CA gate above; both
   must be green before the first artifact exists.
6. **Deployment records are written on the host, not fetched from GitHub.** The
   dashboard deliberately has no GitHub token. A run that fails during build
   (before the deploy job) is visible only in GitHub; deployment attempts that
   reach the deploy job are recorded on the host and displayed.
7. **Phase 6 needs your approval before installation.** The operations broker is
   written and tested but disabled. Review `deploy/ops-permissions.md` — the
   permissions matrix, the gate order, the failure table and the open decision
   about env-file read access — then work through its §11 checklist. Enabling is
   one sudoers rule, one directory and `GRYND_OPS_ENABLED=1`, and none of it has
   been done.

## 11. Command reference

```bash
node deploy/release.mjs status                       # pointers, releases, health, env
node deploy/release.mjs verify <id>
node deploy/release.mjs install <id>                 # incoming/<id> → releases/<id>
node deploy/release.mjs activate <id> --actor=ops --reason="…"
node deploy/release.mjs rollback <id> --confirm <id> --reason="…"
node deploy/release.mjs prune --keep 3
node deploy/release.mjs env | audit --limit 20
node deploy/staging/simulate.mjs
node --test deploy/tests/*.test.mjs

# restricted operations (disabled unless GRYND_OPS_ENABLED=1)
node deploy/ops.mjs status | config | plan <op> --actor=<name> | audit | audit-verify
node deploy/ops.mjs --stdin                          # one JSON request, one response
```

Exit codes: `0` success, `1` activation/health failure, `2` refused (validation,
confirmation, unavailable controller). `--json` on any command for machines;
`--root` overrides `GRYND_RELEASE_ROOT` (default `/home/ubuntu/grynd`).

## 12. Rollback: what it restores and what it cannot

`rollback` is the recovery path for a release that passed its gate and then
misbehaved. It is activation with stricter preconditions: the target must be
installed, must have passed the health gate on this host before
(`state/verified.json`), must not be the release that is already live, and must
be named twice with a reason. It swaps `current` atomically, restarts the units,
runs the same health gate, and appends actor, target sha, previous sha and
reason to `state/audit.jsonl`. Nothing is rebuilt — the artifact is on disk.

Rehearsed on the live host on 2026-10-28 with two releases of the same commit:
activate B (`activated`, app 200 in 460 ms, realtime 200) → rollback to A
(`rolled back …`, app 200 in 450 ms) → activate B again. The build id the server
itself reports in the HTML flipped `83BRWjpEluzBwas6JRBF4` →
`xClmASzhoIr5_sLjoO8Kk` → back, and every attempt is in the audit log with both
shas. The same day, a battery of eleven refusal cases (immutable install, an
uninstalled target, wrong `--confirm`, empty reason, already active, no
`GRYND_ALLOW_SERVICE_RESTART=1`, dry-run controller, CI request for a missing
release, a path as a release id, prune with `--keep 1`) was run against the live
root: every one refused, `current` never moved, and the rejections are recorded.

What a rollback does not restore — plan for these before relying on it:

| Area | Behaviour | What to plan for |
|---|---|---|
| Database schema | Never applied and never reverted. The pipeline does not run migrations at all (`npm run db:migrate`, Drizzle) and migration SQL is not in the artifact | Make each schema change backward compatible for one release (expand → deploy → backfill → contract later); otherwise a code rollback leaves the new schema in place |
| `/api/health` | Reports `db:"ok"` for a reachable database; it cannot detect a schema mismatch | A green gate after a rollback is not proof that the older code matches the current schema |
| Env files (`grynd/env/*.env`) | Not versioned per release, never touched by install, activate or rollback | A release needing a new variable, or a rollback to one needing an old one, is an operator action on the env file |
| systemd units | Not reinstalled or reverted; every release is served through `current`, so a unit change applies to all releases at once | Treat unit files as their own change with their own `daemon-reload` and revert path |
| Realtime process | Restarted only when its tree hash differs from the live release's (`activate.mjs`), so identical trees are not bounced and the socket server keeps running the previous release's byte-identical directory | Check which release dir it resolved: `readlink /proc/$(systemctl show grynd-realtime -p MainPID --value)/cwd`. `prune` never removes the active or previous release, which is also the directory a process may still hold open |
| Browser assets | Chunk filenames change with their contents, so a browser holding pre-rollback HTML can request a chunk the older release does not have and get 404 until it reloads | Expected for a few minutes after a rollback; nothing serves two releases at once |
| Nginx, TLS, DNS, firewall | Untouched by design | Out-of-band changes are not reverted by a rollback |
| `state/` history | Append-only; failed attempts, refusals and reverts are never rewritten or hidden | Read `state/audit.jsonl` and `state/deployments.json` to reconstruct an attempt |
| Release inventory | One `previous` pointer, and only releases that passed the gate on this host are valid targets (`NOT_VERIFIED` otherwise). The first-ever release has no fallback: if its gate fails, `current` is removed and the units have no `WorkingDirectory` | Keep two releases installed and verified; a two-step rollback re-activates each older release explicitly |

Practical notes:

- Run the tooling as `grynd-deploy`. As another account it fails closed with
  `EACCES` on `state/audit.jsonl` (those files are `0640` to that account)
  *before* the pointer moves — production stays healthy, but the refusal reads
  like a broken rollback if you do not know that.
- A rollback needs no rebuild, no migration, no env or unit change, and never
  needs `--allow-out-of-order`.
- A reverted activation is recorded with its `rollback` outcome in
  `state/deployments.json` and fails the workflow run, so it can never be
  mistaken for a green deployment.

## 13. Scheduled jobs (Oracle systemd timers, replaces Vercel Cron)

`vercel.json` schedules five routes. On Oracle they are run by five systemd
timers with the **same routes, the same `CRON_SECRET` bearer token and the same
UTC schedules**, so removing Vercel removes nothing that production still needs.

| Unit (`deploy/jobs/`) | Route | Schedule (UTC) | Effect |
|---|---|---|---|
| `grynd-job-daily-reset.timer` | `/api/jobs/daily-reset` | `00:00` daily | Zeroes `users.daily_wagered` / `daily_won`; no-op when nobody has wagered today |
| `grynd-job-weekly-reset.timer` | `/api/jobs/weekly-reset` | `00:00` Monday | Zeroes weekly counters **and emails every active player** |
| `grynd-job-retention.timer` | `/api/jobs/retention` | `04:00` daily | Deletes terminal matches older than 45 days + stale presence rows |
| `grynd-job-rank-snapshots.timer` | `/api/jobs/rank-snapshots` | `21:00` daily | Records each ranked player's Overall Elo position for the day |
| `grynd-job-last-run-sweep.timer` | `/api/jobs/last-run-sweep` | `17` past every hour | Closes LAST RUN `started` lifecycle rows abandoned for over 10 minutes as `failed` — never as a win |

Installed files:

```
/usr/local/lib/grynd/run-job.sh          root:root 0755   (deploy/jobs/run-job.sh)
/etc/systemd/system/grynd-job@.service   root:root 0644   (deploy/jobs/grynd-job@.service)
/etc/systemd/system/grynd-job-*.timer    root:root 0644   (one per job)
```

`run-job.sh` is root-owned and not writable by `ubuntu`, so the account that runs
the job cannot edit the script the job runs as it. It reads `CRON_SECRET` from
`/home/ubuntu/grynd/env/app.env` (the same 0600 file `grynd-app.service` loads)
and passes it to `curl` on **stdin** via `--config -`, so the secret never appears
in a process argument list or in the journal. Only the HTTP status and a bounded
response excerpt are logged.

### 13.1 Behaviour that makes a failure visible

| Situation | Result |
|---|---|
| Unknown job name | exit 64, nothing invoked |
| `env/app.env` unreadable or `CRON_SECRET` empty | exit 78, nothing invoked (fails closed rather than calling without a token) |
| Connection refused / 502 / 503 / 504 | retried 3× at 10 s intervals (a deploy restarts the app at the top of the hour) |
| Any other non-200 (401, 500, …) | not retried, exit 1 — repeating a 500 does not make it succeed |
| 200 without `"ok": true` (or `"success": true` for snapshots) | exit 1 |
| Exceeds `TimeoutStartSec` (600 s) | unit fails, logged in the journal |

A failed unit is therefore visible in `systemctl --failed`, in
`journalctl -u grynd-job@<name>`, and in `systemctl list-timers`.

### 13.2 Operating it

```bash
systemctl list-timers 'grynd-job-*' --all        # next/last run per job
journalctl -u grynd-job@retention -n 50 --no-pager
sudo systemctl start grynd-job@retention.service # run one now, same unit and env
systemctl cat grynd-job@retention.service        # what is actually installed
```

`Persistent=true` catches up a missed run after a reboot. Because that would
fire an *immediate* catch-up when a timer is first enabled (a stamp file with no
recorded run counts as "missed"), each timer's stamp was pre-seeded on install so
enabling them ran nothing — the first real run is the next scheduled slot, or an
explicit `systemctl start`.

### 13.3 Proof runs on the live host (2026-10-28)

| Job | Result |
|---|---|
| `daily-reset` | `{"ok":true,"reset":0}` — a true no-op at the time (no player had a non-zero daily counter) |
| `retention` | `{"ok":true,…}` — 0 rows older than the cutoff; **found a real defect** (below) |
| `rank-snapshots` | `{"success":true,"bucket":"2026-10-28","captured":0}` — correct: `player_ratings` is empty, so nobody is ranked yet and there is nothing to record |
| `weekly-reset` | **deliberately not executed.** It is destructive and emails every active player; 3 players had non-zero weekly counters and it was mid-week. Automated at `Mon 00:00 UTC`, where it is the intended behaviour |

### 13.4 Defect this work surfaced (fixed)

`retention` purged a table called `lane_runner_pvp_matches`, which **does not
exist** — the lane-runner PvP table is `lane_rush_duel_matches` (already purged)
and `lane_runner_games` is legacy *solo* history that retention leaves alone on
purpose. Every run therefore threw on that statement, recorded `-1` for it, and
still answered `ok: true`, so the sweep could degrade silently forever while the
scheduler reported success. Fixed in `src/app/api/jobs/retention/route.ts`:
the phantom table is gone, and a sweep in which any table failed now returns
HTTP 500 with `failedTables`, which fails the timer.

### 13.5 Before deleting Vercel

Nothing in production reads Vercel for scheduling any more, but until Vercel is
retired its own `vercel.json` crons still fire against the Vercel deployment. Do
not leave both active longer than the observation period: the jobs are idempotent
by design (the resets are single guarded `UPDATE`s, retention only deletes
already-terminal rows, snapshots are `ON CONFLICT` upserts), so doubles are
harmless, but the weekly reset would send its email twice.
