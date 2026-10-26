# GRYND restricted operations — permissions matrix

**Status: implemented, NOT installed, NOT enabled.** Nothing in this document
has touched production. No unit is installed, no sudoers rule exists, no service
was restarted, and execution is refused unless a host explicitly sets
`GRYND_OPS_ENABLED=1` — which is unset by default and is the last step of the
approval checklist, not part of this change.

This is the review artefact requested before any of it is turned on.

---

## 1. What this is

`deploy/ops.mjs` plus `deploy/lib/ops/` is a **fixed, allowlisted operation
broker** for the private Control Center. It is not a web server: the dashboard
spawns it per request, writes one JSON object to stdin and reads one JSON object
from stdout.

```
  operator ──SSH tunnel──► dashboard (Fastify, loopback only, session auth)
                              │  spawns, passes the SESSION actor
                              ▼
                        deploy/ops.mjs --stdin      no socket, no port, no API
                              │
              ┌───────────────┼──────────────────┐
              ▼               ▼                  ▼
        allowlisted      read-only state     hash-chained
        restart argv     (units, releases,   audit log
        (2 commands)      config verdicts)    state/ops/audit.jsonl
              │
              ▼
   sudo -n /usr/bin/systemctl restart <one of two units>
```

Three properties do the actual work:

1. **No general privilege.** The only escalation is a sudoers rule naming two
   exact commands. There is no shell, no `exec`, no file write, no SQL.
2. **No request-shaped commands.** The argv is a frozen array in the source.
   Request fields are an operation id, a token, a phrase, an actor and a reason —
   none of which is ever concatenated into a command.
3. **Two-step confirmation.** A read-only `plan` returns the impact text and a
   signed two-minute token; `apply` must present that token, the exact phrase, an
   actor and a reason, and every one of those is re-validated server-side.

---

## 2. Permissions matrix

### 2.1 What the dashboard CAN read

| # | Capability | Exact mechanism | Returns |
|---|---|---|---|
| R1 | Unit state, two units only | `systemctl is-active grynd-app.service` / `grynd-realtime.service` | `active`, `inactive`, `failed`, `activating`, `deactivating`, `reloading`, `unknown` |
| R2 | Active release metadata | `state/active.json` | release id, commit, activation time |
| R3 | Env file presence and permissions | `stat(2)` on `env/app.env`, `env/realtime.env` | exists, byte size, mode, `modeOk`, uid/gid, whether it sits inside `releases/` |
| R4 | Required configuration keys | the frozen table in `lib/ops/config.mjs` | **key names and rules only** |
| R5 | Per-key verdict | parsed server-side, then discarded | `present: true/false`, `valid: true/false`, `reason: missing / empty / format / unreadable` |
| R6 | Operations audit tail | `state/ops/audit.jsonl` (+ rotated segments) | entries, newest last, redacted |
| R7 | Release audit tail | `state/audit.jsonl` (written by the release tool) | entries, newest last, redacted |
| R8 | Audit chain integrity | recomputed SHA-256 chain | `ok`, `firstSeq`, `lastSeq`, `pruned`, `brokenAt`, `reason` |
| R9 | Whether actions are enabled | process env of the broker | `enabled: true/false` |

**R5 is the hard boundary.** The values are read inside one function, evaluated
against a coarse rule, and only the verdict escapes. No value, prefix, length or
hash of a value is returned. A test writes sentinel secrets into fixture env
files and asserts none of them appears anywhere in the JSON or human output.

### 2.2 What the dashboard CAN modify

| # | Capability | Exact mechanism | Bounds |
|---|---|---|---|
| M1 | Restart `grynd-app.service` | `sudo -n /usr/bin/systemctl restart grynd-app.service` | frozen argv, 30 s timeout, one execution per token |
| M2 | Restart `grynd-realtime.service` | `sudo -n /usr/bin/systemctl restart grynd-realtime.service` | frozen argv, 30 s timeout, one execution per token |
| M3 | Append an auth outcome | `audit.append` with `login.success`, `login.failure` or `auth.denied` | three event names; nothing else is ingestable |
| M4 | Create its own state | `state/ops/{token.key,consumed.jsonl,audit.jsonl,audit.head.json,audit.lock}` | directory `0700`, files `0600`/`0640` |

That is the complete write surface. There is no fourth thing.

### 2.3 What the dashboard CANNOT do

Every row is enforced by the code, not by convention, and the exclusion list is
asserted by a test so it cannot drift away from the implementation.

| Capability | Why it is absent |
|---|---|
| Arbitrary command execution | The runner takes a frozen argv; `assertArgv` re-checks it; a test forbids `shell: true`, `eval`, `new Function`. |
| Arbitrary sudo | The sudoers rule names two commands. `sudo -n` never prompts. |
| Stop / start / disable a unit | Only `restart` exists. Stopping is an outage with no recovery path from the dashboard. |
| Reload Nginx | Needs a separately approved config change and an `nginx -t` gate that do not exist. Deferred to §6.4. |
| Reboot the VM | Takes the host, the tunnel and the dashboard down together. |
| Modify firewall rules | Could lock out the only way back in. |
| Arbitrary file edit / write | Would bypass validation, ownership and atomic-replacement rules. |
| Display or return an env value | The config module builds its result field by field; nothing spreads parsed state. |
| Replace a secret | Explicitly deferred to a separate design review (§6.3). Attempts are refused **and recorded**. |
| Activate / roll back a release | Stays with `deploy/release.mjs`, which requires `--confirm <id>` and a reason. |
| Touch the database | No driver, no SQL, no migration path is imported. Enforced by the existing policy test. |
| Reach another host or port | The health probe refuses non-loopback targets. No outbound client exists otherwise. |
| Persist a network listener | No `http`, `https`, `net` or `createServer` anywhere in the runtime. Enforced by test. |

---

## 3. The two privileged operations

### 3.1 `restart.app` — restart `grynd-app.service`

**Impact shown before confirmation:** the Next.js app stops accepting requests
for a few seconds; in-flight requests fail and the site returns connection
errors until the process is listening again. WebSocket clients are served by
grynd-realtime and are **not** dropped. No release changes.

**Confirmation phrase:** `restart grynd-app.service`
**Timeout:** 30 000 ms for the command; 6 × 500 ms polling for unit state.
**Verification:** unit must be `active` **and** `GET /api/health` must return 200
with `db: "ok"`.

### 3.2 `restart.realtime` — restart `grynd-realtime.service`

**Impact shown before confirmation:** every connected WebSocket is dropped;
clients reconnect with backoff, in-progress realtime rounds are interrupted and
in-memory room state is lost. The Next.js app keeps serving HTTP and
database-backed data is unaffected.

**Confirmation phrase:** `restart grynd-realtime.service`
**Timeout:** 30 000 ms; same polling.
**Verification:** unit must be `active` **and** `GET :3001/health` must return 200.

Both operations also report the **other** unit's state, so an operator can see
that restarting one did not disturb the other.

### 3.3 Not included: automatic remediation

Nothing restarts because a metric is unhealthy. A failing health gate produces a
report and an audit entry. It does not trigger a retry, a restart, a rollback or
a second attempt. A test asserts that a health failure results in exactly one
command execution.

---

## 4. Gate order and failure behaviour

Every gate below runs **in this order**, and each refusal is written to the audit
log before the error is returned.

| # | Gate | Refusal code | Command ran? | What the operator sees |
|---|---|---|---|---|
| 1 | Operation is in the catalogue | `UNKNOWN_OPERATION` | no | "not allowlisted", with the known ids |
| 2 | `GRYND_OPS_ENABLED=1` | `OPS_DISABLED` | no | "disabled on this host" — the shipped default |
| 3 | Authenticated actor present | `ACTOR_REQUIRED` | no | the dashboard must pass the session identity |
| 4 | Reason ≥ 3 chars | `REASON_REQUIRED` | no | a reason is required because it is recorded |
| 5 | Phrase matches exactly | `CONFIRMATION_MISMATCH` | no | the exact phrase to type |
| 6 | Token signature, version, expiry, operation, actor, replay | `TOKEN_INVALID`, `TOKEN_EXPIRED`, `TOKEN_WRONG_OPERATION`, `TOKEN_WRONG_ACTOR`, `TOKEN_REPLAYED` | no | which check failed |
| 7 | argv is the frozen array | `ARGV_MISMATCH` | no | "not the allowlisted argv" |
| 8 | `sudo` and `systemctl` resolve to the allowlisted paths | `BINARY_MISSING`, `BINARY_MISMATCH` | no | which binary failed |
| 9 | Audit "action starting" is written | `AUDIT_UNAVAILABLE` | **no** | refuses rather than act unlogged |
| 10 | Command outcome | — | yes | see below |
| 11 | Verification | — | yes | see below |

### 4.1 After the command

| Situation | `outcome` | `ok` | Honest message |
|---|---|---|---|
| exit 0, unit active, health ok | `verified` | `true` | "completed and was verified" |
| exit 0, unit `failed` or health failed | `verification_failed` | `false` | "do not treat this as a successful restart" — a crash-looping unit exits 0 |
| non-zero exit | `command_failed` | `false` | includes the exit code |
| killed at the timeout | `timed_out` | `false` | "this is NOT a confirmed restart" — state is still checked and reported |
| result entry could not be written | (unchanged) | `false` if not verified | the response carries a warning that the result is unlogged |

A `timed_out` action still runs the verification. The restart may well have
happened; guessing either way would be dishonest.

### 4.2 A refused or broken audit

- If the **"action starting"** entry cannot be written, the command **does not
  run**. An unlogged privileged action is the exact failure the log exists to
  prevent.
- If the **"result"** entry cannot be written, the action already happened, so
  the response says so explicitly instead of implying it was recorded.
- If an audit write for a **refusal** fails, the refusal still happens. The
  refusal is the safety property; the log is the evidence.

---

## 5. Configuration: what is exposed

The brief forbids displaying raw `.env` values and asks for validation without
returning contents. That is what §2.1 R3–R5 provide:

```json
{
  "name": "app.env",
  "present": true,
  "mode": "0600",
  "modeOk": true,
  "owner": { "uid": 1000, "gid": 1000 },
  "insideRelease": false,
  "readable": true,
  "malformedLines": 0,
  "keys": [
    { "key": "DATABASE_URL",              "rule": "postgres-url",     "present": true, "valid": true,  "reason": null },
    { "key": "REALTIME_INTERNAL_SECRET",  "rule": "long-secret",      "present": true, "valid": false, "reason": "format" }
  ],
  "keysValid": 5,
  "keysRequired": 6,
  "ok": false
}
```

No value appears. Note what is deliberately **not** reported: no value, no
prefix, no length, no checksum. A checksum of a low-entropy secret is a lookup
table.

### 5.1 The tradeoff this creates — read this before approving

Validation requires **reading** the file. As the system is installed today
(`deploy/README.md` §9.1), `grynd-cc` can `stat` `env/*.env` but cannot read
them, so a validation report would show `readable: false` and every key as
`unreadable`.

There are two ways forward, and this needs your decision:

| Option | Effect | Cost |
|---|---|---|
| **(a) Grant read access** to `env/*.env` for the dashboard account | Validation works immediately | The dashboard account can now read every secret. The interface never returns them, but a compromised dashboard process could. |
| **(b) Separate validator (recommended)** | The dashboard never holds read access | A small helper run as `ubuntu` via one scoped sudoers rule returns only verdicts. Not implemented; a contained change. |

**Recommendation: (b).** It keeps secret-read capability out of the process that
serves HTTP — the one most exposed to a web bug — and the helper's entire
contract is "verdicts only", which is easier to review than "the whole config
module is careful".

---

## 6. Deferred: secret replacement

Not implemented. `config.set` exists only to **refuse and record** the attempt
(`NOT_IMPLEMENTED`, audit event `config.change.denied`).

### 6.1 Why

The brief is explicit: do not implement secret editing until the configuration
format, file ownership, rollback approach and restart behaviour have been tested
independently. None of those has been tested, so there is no write path.

### 6.2 Requirements for the reviewed version

Recorded here so the design review starts from the agreed contract:

1. reauthentication immediately before the change;
2. explicit confirmation naming the exact key;
3. the old and new values are never displayed again after submission;
4. request bodies and values are never logged;
5. write to a secure temporary file in the same directory, then atomic `rename(2)`;
6. preserve existing ownership and mode (0060/0600), never widen them;
7. validate the new configuration before activation;
8. keep a recoverable prior copy (e.g. `env/app.env.bak-<stamp>`, 0600) without ever exposing it;
9. state which unit must restart;
10. require a **separate** explicit confirmation for that restart.

### 6.3 What must be tested first

Format round-trip (quoting, multi-line values, comments preserved), ownership
preservation across `rename`, rollback of a bad value, and the restart decision
for each key. Until then the button does not exist.

### 6.4 Nginx reload

Deliberately absent. `nginx -s reload` is only safe when the candidate config has
already passed `nginx -t` and been approved separately; neither that approval
record nor a sudoers rule for nginx exists in this architecture. Shipping the
button without the gate would be the insecure half of the feature. Excluded in
`EXCLUDED_ACTIONS` with this reason, and asserted by a test.

---

## 7. Audit log

`state/ops/audit.jsonl`, plus rotated segments.

### 7.1 Events

| Event | Written by | When |
|---|---|---|
| `ops.plan` | runtime | a plan token is minted (records the fingerprint, never the token) |
| `ops.denied` | runtime | any refusal, with the gate's code |
| `service.action.start` | runtime | immediately before the command — the fail-closed gate |
| `service.action.result` | runtime | after verification, with outcome, command result and health |
| `config.read` | runtime | a configuration report is produced |
| `config.change.denied` | runtime | someone attempted a configuration write |
| `login.success` | dashboard, via `audit.append` | successful sign-in |
| `login.failure` | dashboard, via `audit.append` | failed sign-in |
| `auth.denied` | dashboard, via `audit.append` | authorization failure |

Deployment and rollback events live in `state/audit.jsonl`, written by
`deploy/release.mjs`. The dashboard reads both logs as one merged, read-only
view; it does not write to the release log.

### 7.2 What is never recorded

Passwords, tokens, session cookies, private keys, secret values, request bodies.
Two layers enforce it: the audit writer redacts before hashing, and the read path
redacts again. The plan token is stored only as a 16-hex fingerprint, so a plan
can be correlated with its `apply` without the token being recoverable.

Redaction is narrow on purpose — it targets unambiguous credentials (PEM blocks,
JWTs, bearer headers, DSN passwords, `sk_`/AWS/GitHub/Slack key shapes,
`KEY=value` where the key name announces a secret). Unit names, release ids and
commit shas stay readable, because an audit log nobody can read is not an audit
log.

### 7.3 Protection against modification

| Control | Status |
|---|---|
| Directory `state/ops/` `0700`, owned by the dashboard account | to install |
| Files `0640`, not writable by the application account (`ubuntu`) | to install |
| Hash chain: each entry carries `prevHash` and its own SHA-256 | **implemented** |
| `verifyAudit` reports the first broken link, not just a boolean | **implemented** |
| `chattr +a` (kernel append-only) | optional hardening, needs root; documented, not required |

**Honest limit:** a writer holding the file's permissions can replace the whole
file with a freshly-computed chain; nothing key-based stops that. The chain
detects editing, deletion and reordering of individual entries; prevention is
POSIX ownership plus, optionally, `chattr +a`. This is stated rather than
overclaimed.

### 7.4 Retention

10 000 entries per segment, 2 archives kept (≈30 000 entries), then the oldest
segment is deleted. Rotation moves whole files, so no entry is ever rewritten.
When the oldest entries have been pruned, `verifyAudit` returns `pruned: true`
and `firstSeq` instead of falsely reporting tampering — an alarm that fires on a
healthy log trains an operator to ignore it.

---

## 8. Installation prerequisites (none of these are done)

For review only. Each step is separately approvable.

```bash
# 1. Own the ops state directory (mode 0700, not writable by ubuntu).
sudo install -d -m 700 -o grynd-cc -g grynd-cc /home/ubuntu/grynd/state/ops

# 2. Scoped privilege: the two restarts, nothing else.
#    Verify the path first with: command -v systemctl
sudo tee /etc/sudoers.d/grynd-cc >/dev/null <<'EOF'
grynd-cc ALL=(root) NOPASSWD: /usr/bin/systemctl restart grynd-app.service, /usr/bin/systemctl restart grynd-realtime.service
EOF
sudo chmod 0440 /etc/sudoers.d/grynd-cc
sudo visudo -cf /etc/sudoers.d/grynd-cc

# 3. Token key (or set GRYND_OPS_TOKEN_SECRET in the broker's environment).
#    Generated automatically on first plan, 0600. Nothing to do manually.

# 4. Enable — ONLY after this document is approved.
#    Leave GRYND_OPS_ENABLED unset until then.
```

Two accounts now hold a restart rule (`grynd-deploy` for releases, `grynd-cc`
for the dashboard). Whether to merge them is your call; keeping them separate
means a compromise of one does not inherit the other's reach.

---

## 9. Testing

`node --test deploy/tests/ops.test.mjs` — **55 tests**, all passing.

Covered, mapped to the brief:

| Requirement | Tests |
|---|---|
| Authorization failures | unknown operation, missing actor, disabled host, only `"1"` enables, both units |
| CSRF/replay | single-use token, cross-operation token, cross-actor token, expiry, forged/malformed, foreign key |
| Confirmation requirements | exact phrase, case/whitespace tolerance, wrong/missing phrase, refusal does not burn the token |
| Command allowlisting | frozen argv, injected text, mutated copy, binary resolution, no shell |
| Timeouts | timed-out command reported as such, verified anyway, never retried |
| Secret redaction | config output (human + JSON), audit log, reason field, value patterns, identifiers stay readable |
| Audit completeness | plan/denial/start/result for every outcome, tamper detection, deletion detection, rotation and pruning, ingest whitelist |
| Broker protocol | unknown action, unknown field, malformed JSON, oversized body, end-to-end plan→apply refusal |

The existing 65 deploy tests still pass (`120` total, `1` POSIX-only skip on
Windows), the 49-check staging simulation still reports `49/49`, and
`lint:release` is clean.

### 9.1 What is NOT tested — and cannot be here

- **No real systemd or sudo.** The unit reader and command runner are injected in
  every test. A real `systemctl restart` has never run from this code.
- **No real port, TLS, tunnel or Postgres.** The health gate is exercised with an
  injected gate; the real probe lives in `lib/health.mjs` and is covered by the
  staging simulation.
- **No destructive test against production.** As required. No test is capable of
  reaching a real unit: the broker tests stop at the confirmation gate, and the
  runner is always a spy.
- **The dashboard side is not here.** Loopback binding, SSH-tunnel-only access,
  session auth and per-page authentication belong to `grynd-control-center`, in
  its own repository. This code assumes an already-authenticated caller and
  takes the actor as a parameter.

---

## 10. Residual risks and decisions for you

1. **Env read access for validation** — §5.1. Choose (a) grant read or (b) build
   the separate validator. Recommendation: (b).
2. **The actor is asserted, not authenticated.** This broker trusts the `actor`
   field because it trusts its caller. The dashboard **must** pass the session
   identity, never a request field. That contract is documented at the call site
   and must be reviewed in the dashboard repo. There is no way to enforce it from
   this side without coupling to the dashboard's session store.
3. **Reason text is echoed in the response.** It is redacted in the audit log but
   returned verbatim to the caller — it is their own text. If you would rather it
   be redacted in the response too, that is a one-line change.
4. **No reauthentication for restarts.** The brief requires reauthentication for
   secret updates, not for restarts; the two-step token plus phrase is what
   guards these. Adding a password prompt per restart would be a dashboard change.
5. **Plan tokens are cheap to mint.** A caller who is already authenticated can
   request many. Anything that can call the broker can already run two commands,
   so this is not a privilege escalation — but rate limiting belongs in the
   dashboard if it matters to you.
6. **Retention deletes old audit data** by design (§7.4). If you need longer
   retention, raise `DEFAULT_MAX_ENTRIES` / `MAX_ARCHIVES` and plan the disk use.
7. **Two accounts with restart rights** (§8). Merge or keep separate — your call.

---

## 11. Approval checklist

Nothing below has been performed.

- [ ] Review the permissions matrix in §2 and confirm the write surface (M1–M4) is exactly what you intended.
- [ ] Decide §5.1 (env read access vs a separate validator).
- [ ] Review the gate order and failure table in §4.
- [ ] Approve the two sudoers entries in §8 and confirm `command -v systemctl`.
- [ ] Run one restart of each unit on **staging**, with `GRYND_OPS_ENABLED=1`, and confirm the audit entries, the verification output and the recovery path.
- [ ] Confirm the dashboard passes the session actor, not a request field (§10.2).
- [ ] Confirm the dashboard remains loopback-only, tunnel-only, authenticated on every page and API, with no public DNS or Nginx route.
- [ ] Only then: install the sudoers rule, create `state/ops/`, set `GRYND_OPS_ENABLED=1`.
- [ ] Separately: decide whether to begin the secret-update design review (§6), and the Nginx reload question (§6.4).
