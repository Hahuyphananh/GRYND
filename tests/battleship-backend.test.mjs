// tests/battleship-backend.test.mjs
//
// Source contracts for ranked Battleship ONLINE (Phases 3 + 4).
//
// These assertions pin the properties a database-free environment cannot
// exercise. They read the shipped source and fail if a later edit quietly:
//
//   * drops the authentication gate from a route;
//   * accepts a phase, a seat, a player id, a readiness flag, a coordinate
//     RESULT or a winner from a request body;
//   * leaks the opponent's private fleet anywhere in a projection or a socket
//     payload;
//   * returns the raw match row instead of the whitelist projection;
//   * adds a stake/escrow/payout path (Battleship is free to play);
//   * resolves a round outside the engine, without a row lock, without the
//     unique lock constraint, or before the transaction commits;
//   * bypasses the advisory lock, the conditional UPDATE or the canonical match
//     lifecycle;
//   * forgets the migration, its journal entry, its schema tables, the queue
//     adapter or the retention purge.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (relative) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");

const STORE = read("src/lib/battleship/serverStore.ts");
const SEATS = read("src/lib/battleship/seats.ts");
const ROOMS = read("src/lib/battleship/rooms.ts");
const COMBAT = read("src/lib/battleship/combat.ts");
const CONSTANTS = read("src/lib/battleship/constants.ts");
const SCHEMA = read("src/db/schema.ts");
const MIGRATION = read("src/db/migrations/0236_battleship.sql");
const JOURNAL = JSON.parse(read("src/db/migrations/meta/_journal.json"));
const RETENTION = read("src/app/api/jobs/retention/route.ts");
const QUICK_QUEUE = read("src/lib/quickQueue.ts");
const WORKER = read("src/lib/quickQueueWorker.ts");

const ROUTES = {
  matchmaking: "src/app/api/battleship/create-or-join/route.ts",
  available: "src/app/api/battleship/available/route.ts",
  match: "src/app/api/battleship/match/[matchId]/route.ts",
  fleet: "src/app/api/battleship/match/[matchId]/fleet/route.ts",
  attack: "src/app/api/battleship/match/[matchId]/attack/route.ts",
  cancel: "src/app/api/battleship/match/[matchId]/cancel/route.ts",
  resign: "src/app/api/battleship/match/[matchId]/resign/route.ts",
};

/** Comments are documentation, not behaviour: assertions run on code only. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/^[ \t]*--.*$/gm, "");
}

/** The schema block for one table, so column assertions stay table-scoped. */
function tableBlock(name) {
  // schema.ts is CRLF, so match the newline rather than assume one flavour.
  const start = SCHEMA.search(new RegExp(`pgTable\\(\\r?\\n  "${name}"`));
  assert.ok(start > -1, `schema is missing the ${name} table`);
  const rest = SCHEMA.slice(start);
  const end = rest.search(/\r?\n\);/);
  return end === -1 ? rest : rest.slice(0, end);
}

// ── Authentication ────────────────────────────────────────────────────────

test("every Battleship route sits behind the existing authenticated-player gate", () => {
  for (const [name, file] of Object.entries(ROUTES)) {
    assert.ok(fs.existsSync(file), `missing route: ${name}`);
    const source = read(file);
    assert.match(
      source,
      /import \{ requireAgeVerifiedUser \} from /,
      `${name} must reuse the existing Clerk-backed gate`,
    );
    assert.match(source, /const gate = await requireAgeVerifiedUser\(\);/, `${name} must call the gate`);
    assert.match(source, /if \(gate\.response\) return gate\.response;/, `${name} must return the gate response`);
    assert.match(source, /if \(!userId\)/, `${name} must refuse an unauthenticated caller`);
    assert.doesNotMatch(source, /requirePracticePlayer|guestId|guest_/, `${name} must not accept guests`);
    assert.doesNotMatch(source, /auth\(\)|clerkMiddleware|getAuth\(/, `${name} must not roll its own auth`);
  }
});

test("no route lets a client choose its own identity", () => {
  for (const file of Object.values(ROUTES)) {
    const source = read(file);
    assert.match(source, /userId\b/, "the route must use gate.userId");
    assert.doesNotMatch(
      source,
      /body\??\.\s*(userId|playerId|player1Id|player2Id|seat)\b/,
      "no identity may be read from the body",
    );
    assert.doesNotMatch(source, /searchParams\.get\(\s*["'](userId|playerId|seat)/, "no identity from the query string");
  }
});

// ── Matchmaking ───────────────────────────────────────────────────────────

test("matchmaking reuses the game store instead of a parallel queue", () => {
  const source = read(ROUTES.matchmaking);
  assert.match(source, /import \{ createOrJoin, matchDto \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/battleship\/serverStore"/);
  assert.match(source, /await createOrJoin\(\{ userId \}\)/);
  assert.doesNotMatch(source, /INSERT INTO|matchmaking_queue|new Map\(\)/, "no second queue may exist");
});

test("the store serialises lobby creation under one per-game advisory lock", () => {
  assert.match(STORE, /pg_advisory_xact_lock\(\$\{BATTLESHIP_LOCK_NAMESPACE\}, 0\)/);
  assert.match(STORE, /db\.transaction\(/);
  assert.match(CONSTANTS, /BATTLESHIP_LOCK_NAMESPACE = 0x42534850 & 0x7fffffff/);
  for (const other of ["BARRICADE_LOCK_NAMESPACE", "HILLSTRIKE_LOCK_NAMESPACE", "DOMINOES_LOCK_NAMESPACE"]) {
    assert.doesNotMatch(STORE, new RegExp(other), "Battleship must not borrow another game's lock");
  }
});

test("the second seat is claimed by a conditional UPDATE, never a blind write", () => {
  assert.match(STORE, /\.where\(\s*\n?\s*and\(\s*\n?\s*eq\(battleshipMatches\.id, candidateId\),\s*\n?\s*eq\(battleshipMatches\.phase, MATCH_PHASE\.WAITING\),\s*\n?\s*isNull\(battleshipMatches\.player2Id\)/);
  assert.match(STORE, /if \(!updated\) return \{ error: "Match is no longer available", status: 409 \}/);
});

test("self-join, duplicate seats and non-waiting lobbies are refused", () => {
  assert.match(STORE, /canJoinLobby\(open, userId\)/);
  assert.match(STORE, /canJoinLobby\(match, userId\)/);
  assert.match(SEATS, /reason: "self"/);
  assert.match(SEATS, /reason: "taken"/);
  assert.match(SEATS, /reason: "not-open"/);
});

test("Battleship joins the ONE global quick queue through its adapter", () => {
  assert.match(QUICK_QUEUE, /QUICK_QUEUE_GAME_KEYS/);
  assert.match(QUICK_QUEUE, /"battleship",/);
  assert.match(WORKER, /import \{ createOrJoin as createOrJoinBattleshipMatch \} from "\.\/battleship\/serverStore"/);
  assert.match(WORKER, /"battleship": \(userId\) => createOrJoinBattleshipMatch\(\{ userId \}\)/);
});

// ── Database ──────────────────────────────────────────────────────────────

test("the migration is journaled under a fresh index and tag", () => {
  const entry = JOURNAL.entries.find((candidate) => candidate.tag === "0236_battleship");
  assert.ok(entry, "0236_battleship must be in the Drizzle journal");
  assert.equal(entry.idx, 217);
  assert.equal(entry.version, "7");
  assert.ok(entry.when > 0);

  const indices = JOURNAL.entries.map((candidate) => candidate.idx);
  assert.equal(new Set(indices).size, indices.length, "journal indices must be unique");
});

test("the migration creates only the three Battleship structures", () => {
  const created = [...MIGRATION.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(created, ["battleship_matches", "battleship_fleets", "battleship_attacks"]);
  assert.match(MIGRATION, /"placement" text NOT NULL/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS "battleship_fleets_match_seat_unique"/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS "battleship_attacks_round_seat_unique"/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX IF NOT EXISTS "battleship_attacks_coordinate_unique"/);
  assert.match(MIGRATION, /REFERENCES "battleship_matches" \("id"\) ON DELETE CASCADE/);
});

test("the Drizzle schema mirrors the migration", () => {
  assert.match(SCHEMA, /export const battleshipMatches = pgTable\(/);
  assert.match(SCHEMA, /export const battleshipFleets = pgTable\(/);
  assert.match(SCHEMA, /export const battleshipAttacks = pgTable\(/);

  const matches = tableBlock("battleship_matches");
  for (const column of [
    "player1Id",
    "player2Id",
    "phase",
    "round",
    "player1Ready",
    "player2Ready",
    "winnerId",
    "result",
    "placementDeadline",
    "roundDeadline",
    "player1Timeouts",
    "player2Timeouts",
    "startedAt",
    "endedAt",
    "createdAt",
    "updatedAt",
  ]) {
    assert.match(matches, new RegExp(`${column}:`), `battleship_matches is missing ${column}`);
  }

  const fleets = tableBlock("battleship_fleets");
  assert.match(fleets, /seat:/);
  assert.match(fleets, /placement:/);
  assert.match(fleets, /unique\("battleship_fleets_match_seat_unique"\)/);

  const attacks = tableBlock("battleship_attacks");
  assert.match(attacks, /coordinate:/);
  assert.match(attacks, /unique\("battleship_attacks_round_seat_unique"\)/);
  assert.match(attacks, /unique\("battleship_attacks_coordinate_unique"\)/);
});

test("finished and cancelled matches are purged with their fleets", () => {
  assert.match(RETENTION, /await purge\("battleship_matches", \["finished", "cancelled"\]\)/);
});

// ── Phases ────────────────────────────────────────────────────────────────

test("the five contractual phases exist and nothing else does", () => {
  const block = CONSTANTS.slice(
    CONSTANTS.indexOf("export const MATCH_PHASE"),
    CONSTANTS.indexOf("} as const;", CONSTANTS.indexOf("export const MATCH_PHASE")),
  );
  const phases = [...block.matchAll(/(\w+): "(\w+)"/g)].map((m) => m[2]);
  assert.deepEqual(phases, ["waiting", "placement", "combat", "finished", "cancelled"]);
});

test("the store derives the phase from readiness and never writes a client phase", () => {
  assert.match(STORE, /const phase = phaseForFleetReadiness\(player1Ready, player2Ready\)/);
  assert.match(SEATS, /return player1Ready && player2Ready \? MATCH_PHASE\.COMBAT : MATCH_PHASE\.PLACEMENT/);
  for (const file of Object.values(ROUTES)) {
    assert.doesNotMatch(read(file), /phase:\s*(body|req|payload|input)/, "no route may set a phase");
  }
});

test("a fleet cannot be confirmed before an opponent exists or after combat opens", () => {
  assert.match(STORE, /canConfirmFleet\(\{ phase: row\.phase, seats: row, userId \}\)/);
  assert.match(SEATS, /if \(input\.phase === MATCH_PHASE\.WAITING\)/);
  assert.match(SEATS, /if \(input\.phase === MATCH_PHASE\.COMBAT\)/);
});

// ── Lifecycle ─────────────────────────────────────────────────────────────

test("the canonical lifecycle row is created and advanced with the match", () => {
  assert.match(STORE, /import \{ createMatchLifecycle, transitionMatchLifecycle \} from "\.\.\/matchLifecycleStore"/);
  assert.match(STORE, /await createMatchLifecycle\(\{/);
  for (const to of ["forming", "ready", "started"]) {
    assert.match(STORE, new RegExp(`transitionMatchLifecycle\\(\\{ matchId: candidateId, to: "${to}"`));
  }
  assert.match(STORE, /to: "cancelled",\s*\n\s*cancelReason: "user_cancelled"/);
  assert.match(STORE, /to: "completed"/, "a decided match completes its lifecycle");
  assert.match(STORE, /tx,\s*\n\s*\}\);/);
});

test("every mutation locks its row and commits in a transaction", () => {
  const locks = [...STORE.matchAll(/\.for\("update"\)/g)].length;
  assert.ok(locks >= 5, `expected a FOR UPDATE in every mutation, found ${locks}`);
  assert.match(STORE, /if \(!updated\) \{\s*\n\s*return \{ error: "Match changed concurrently; retry the request", status: 409 \}/);
});

test("a repeated fleet confirmation is idempotent", () => {
  assert.match(STORE, /if \(alreadyReady\) \{/);
  assert.match(STORE, /return \{ dto: await buildDto\(row, seat, tx\), confirmed: true \}/);
});

// ── Combat authority ──────────────────────────────────────────────────────

test("one server-authoritative resolution, inside the engine and inside the transaction", () => {
  assert.match(STORE, /const resolution = resolveRound\(state, submissions\)/);
  // Practice pre-fills the bot's lock, so the merge can differ from the plain
  // manual insert — but the round is still judged by the shared lock check.
  assert.match(STORE, /const locked = roundLocked\(merged, row\.round\)/);
  assert.match(STORE, /if \(!locked\.player1 \|\| !locked\.player2\)/);
  assert.match(STORE, /if \(row\.round !== expectedRound\(attacks\)\)/);
  assert.match(STORE, /hasAttacked\(resolvedRecords\(attacks, seat\), parsed\)/);
  // Result and winner are the engine's values, never a request's.
  assert.match(STORE, /result: resolution\.round\.outcome \?\? null/);
  assert.match(STORE, /resolution\.state\.winner === "player1"/);
  assert.match(ROUTE_ATTACK(), /await submitAttack\(\{ userId, matchId, coordinate: body\?\.coordinate \}\)/);
});

function ROUTE_ATTACK() {
  return read(ROUTES.attack);
}

test("the round cannot be resolved twice or revived after the match ended", () => {
  assert.match(
    STORE,
    /eq\(battleshipMatches\.round, row\.round\),\s*\n\s*eq\(battleshipMatches\.phase, MATCH_PHASE\.COMBAT\)/,
  );
  assert.match(STORE, /if \(!updated\) \{\s*\n\s*return \{ error: "The round changed concurrently; retry the request", status: 409 \}/);
  assert.match(STORE, /pnConflictDoNothing|\.onConflictDoNothing\(\)/);
  assert.match(STORE, /UNIQUE|unique/, "the lock uniqueness is documented in the store");
});

test("both attacks are stored together and neither is published early", () => {
  assert.match(STORE, /for \(const shotSeat of SEATS\) \{/);
  assert.match(STORE, /\.set\(\{ result: attack\.result, ship: attack\.ship \}\)/);
  assert.doesNotMatch(STORE, /broadcast/, "publication lives in the route, after the commit");
  const publishAt = read(ROUTES.attack).indexOf("publishRoundResult(matchId, round)");
  const commitAt = read(ROUTES.attack).indexOf("await submitAttack");
  assert.ok(publishAt > commitAt, "results are published only after the transaction");
  assert.match(read("src/lib/battleship/publish.ts"), /BATTLESHIP_EVENTS\.ROUND_RESOLVED/);
});

test("the store's combat helpers do not invent state", () => {
  assert.match(COMBAT, /export function buildMatchState/);
  assert.match(COMBAT, /const outcome: MatchOutcome \| null =/);
  assert.match(COMBAT, /validateMatchState\(state\)\.ok \? state : null/);
  assert.doesNotMatch(COMBAT, /Math\.random|fetch\(|db\./, "combat.ts stays pure");
});

// ── Privacy ───────────────────────────────────────────────────────────────

test("both fleets are read server-side but only the viewer's own is projected", () => {
  assert.match(STORE, /async function bothFleets\(/);
  assert.match(STORE, /\.select\(\{ seat: battleshipFleets\.seat, placement: battleshipFleets\.placement \}\)/);
  assert.match(STORE, /combat = matchViewForSeat\(state, seat\)/);
  assert.match(STORE, /const own = fleets \? fleets\[seat\] : await ownFleet/);

  const dto = STORE.slice(STORE.indexOf("export function matchDto"), STORE.indexOf("async function ownFleet"));
  assert.doesNotMatch(dto, /\.\.\.row/, "the match row must never be spread into a response");
  assert.doesNotMatch(dto, /opponentFleet|opponent\.fleet/);
  assert.match(dto, /fleet: fleet \? \{ ships: fleet\.ships \} : null/);
});

test("a read of someone else's match is refused before any fleet is touched", () => {
  const fetchBody = STORE.slice(
    STORE.indexOf("export async function fetchMatch"),
    STORE.indexOf("// ── Fleet confirmation"),
  );
  const access = fetchBody.indexOf("requireSeat(row, userId)");
  const dto = fetchBody.indexOf("buildDto(current, access.seat)");
  assert.ok(access > -1 && dto > access, "the seat check must precede any projection");
  assert.match(fetchBody, /status: access\.status/);
});

test("no handler returns the raw match row", () => {
  for (const file of Object.values(ROUTES)) {
    assert.doesNotMatch(read(file), /data:\s*(result\.)?(match|row)\b(?!\w)/, "routes must return the DTO");
  }
  assert.match(read(ROUTES.match), /data: \{ \.\.\.result\.dto, players \}/);
});

test("realtime pushes carry only invalidations", () => {
  assert.match(ROOMS, /BATTLESHIP_MATCH_ROOM_PREFIX = "battleship:match:"/);
  assert.match(ROOMS, /matchId,\s*\n\s*\.\.\.safePayload,\s*\n\s*sentAt: new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(stripComments(ROOMS), /placement|fleet|ships|coordinate/, "no fleet data may be broadcast");
  for (const file of Object.values(ROUTES)) {
    assert.doesNotMatch(stripComments(read(file)), /broadcastBattleshipEvent\([^)]*fleet/i);
  }
});

// ── Economy ───────────────────────────────────────────────────────────────

test("Battleship moves no coins", () => {
  for (const [label, source] of [
    ["store", stripComments(STORE)],
    ["schema table", stripComments(tableBlock("battleship_matches"))],
    ["migration", stripComments(MIGRATION)],
  ]) {
    assert.doesNotMatch(
      source,
      /\b(stake|stakeAmount|wager|wagerAmount|escrow|payout|rake)\b/i,
      `${label} must not carry a stake`,
    );
  }

  // The queue worker handles every game's stake, so only the Battleship adapter
  // line is in scope: it must take a user id and nothing else.
  const adapter = WORKER.split("\n")
    .filter((line) => /"battleship":/.test(line))
    .join("\n");
  assert.ok(adapter.length > 0, "the Battleship queue adapter must exist");
  assert.doesNotMatch(adapter, /stake|wager|betAmount|entryFee|escrow/i);

  for (const file of Object.values(ROUTES)) {
    const source = stripComments(read(file));
    assert.doesNotMatch(source, /requireStake|deductTokens|creditTokens|tokenAmount|entryFee/i);
    assert.doesNotMatch(source, /\b(stake|wager|escrow|payout)\b/i, "the route must not accept a stake");
  }
  assert.doesNotMatch(
    stripComments(tableBlock("battleship_matches")),
    /\b(stake|wager|pot|escrow|payout)\b/i,
  );
});

// ── Route surface ─────────────────────────────────────────────────────────

test("the API surface is matchmaking, lobby, snapshot, fleet, attack, cancel, resign and the practice entry", () => {
  const apiRoot = path.join(process.cwd(), "src/app/api/battleship");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
    }
  };
  walk(apiRoot);
  assert.deepEqual(files.sort(), [
    "src/app/api/battleship/available/route.ts",
    "src/app/api/battleship/create-ai/route.ts",
    "src/app/api/battleship/create-or-join/route.ts",
    "src/app/api/battleship/disconnect-forfeit/route.ts",
    "src/app/api/battleship/match/[matchId]/attack/route.ts",
    "src/app/api/battleship/match/[matchId]/cancel/route.ts",
    "src/app/api/battleship/match/[matchId]/fleet/route.ts",
    "src/app/api/battleship/match/[matchId]/resign/route.ts",
    "src/app/api/battleship/match/[matchId]/route.ts",
    "src/app/api/battleship/practice/[matchId]/attack/route.ts",
    "src/app/api/battleship/practice/[matchId]/fleet/route.ts",
    "src/app/api/battleship/practice/[matchId]/route.ts",
  ]);
});

test("resignation is server-authoritative and settles through the shared finish path", () => {
  const source = stripComments(read(ROUTES.resign));
  assert.match(source, /await resignMatch\(\{ userId, matchId \}\)/);
  assert.match(source, /reason: "resigned"/);
  assert.doesNotMatch(source, /req\.json|body\./, "a resign request carries no client fields");

  assert.match(STORE, /canResign\(/);
  assert.match(STORE, /const winnerSeat = otherSeat\(can\.seat\)/);
  assert.match(STORE, /finishMatchTx\(tx, row, winnerSeat, "resigned", now\)/);
});
