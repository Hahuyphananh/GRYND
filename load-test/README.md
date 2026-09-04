# Grynd HTTP load tests (Artillery)

Drives the **wagering** and **read** hot paths from `docs/load-testing.md`
against a staging environment. Never point these at production.

## Files

- `scenarios/read-mix.yml`  — steady read load: leaderboards, bet history, user
  stats, crash-arena lobby/table polls, recent games.
- `scenarios/wagering.yml` — the money path: `create` (table) → `join`
  (atomic balance buy-in). Add `cashout`/`settle` steps once staging has
  reliably auto-cycling tables (see the plan doc §7).
- `tokens.example.csv` — copy to `tokens.csv` (gitignored) and fill with one
  Clerk `__session` cookie per virtual user.

## Prerequisites (staging)

1. Install: `npm install` (adds the `artillery` devDependency).
2. Create `load-test/tokens.csv`:
   ```bash
   cp load-test/tokens.example.csv load-test/tokens.csv
   # paste one __session value per line (header: cookie)
   ```
   Getting a token: sign in to staging, DevTools → Console →
   `localStorage.getItem("__session")`. Clerk tokens are short-lived — mint
   fresh ones per run and create **at least as many tokens as peak VUs**
   (Artillery assigns one payload row per VU; see "Concurrency math" below).
3. Fund every test account (starting balance ≥ wagers the run will place) and
   seed a production-like dataset — empty tables hide every index problem.
4. Set `BASE_URL` to the staging origin (no trailing slash).

## Run

```bash
# Set BASE_URL from load-test/.env.local (fill it in first!), then run:
set -a; source load-test/.env.local; set +a

# Read mix — ~50 VUs, 90 s (needs >= ~60 tokens; duplicates OK, reads only)
npx artillery run load-test/scenarios/read-mix.yml

# Wagering — create + atomic buy-in cycles (needs >= ~35 unique tokens, funded)
npx artillery run load-test/scenarios/wagering.yml

# Save a JSON report for later comparison
npx artillery run -o load-test/reports/run-$(date +%s).json load-test/scenarios/read-mix.yml
npx artillery report load-test/reports/run-*.json   # opens an HTML report
```

Add `npm` scripts any time by editing `package.json` (pattern:
`"loadtest:read": "artillery run -e ..."`).

## Interpreting results

- Watch **p95 latency, error rate, and HTTP status distribution** in the
  summary (`config.ensure` fails the run if budgets are exceeded).
- Correlate a slow run with the DB: check `pg_stat_activity` for long queries,
  `pg_locks` for waits, Redis `grynd:lb:*` hit rates. Slow leaderboards right
  after settlement traffic = cache purge → recompute (plan §4.3).
- Run the money-integrity SQL from `docs/load-testing.md` §6 **before and
  after** every wagering run — a load test that corrupts a balance is a
  failing test.

## Concurrency math (Artillery arrivals vs tokens)

`arrivalRate` = new VUs per *second*, so total VUs over a phase ≈
`arrivalRate × duration`. One payload row is consumed per VU. With a small
token set, lower `arrivalRate` and raise the per-iteration `think`/loop count
so the same VUs stay busy. Tune to: **total arrivals ≤ tokens**.
