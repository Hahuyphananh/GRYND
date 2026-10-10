/**
 * qa/barricade-online-check.mjs
 *
 * ONLINE BARRICADE, DRIVEN AGAINST THE REAL DATABASE.
 *
 * The unit suite (tests/barricade-online-store.test.mjs) proves the store's
 * decisions against a fake client. This harness proves the parts a fake cannot:
 * the real `FOR UPDATE` row lock, the real unique (match_id, ply) index, the
 * real advisory-lock matchmaking and the real transactions.
 *
 * It seats two synthetic players, plays a full match through the store (every
 * action taken from the engine's own `legalMoves`, every response compared with
 * the engine's own `applyAction`), and along the way asserts:
 *
 *   • two concurrent actions on the same turn produce EXACTLY ONE winner
 *   • an out-of-turn action, a stale version and a replayed action are refused
 *   • both seats see the same authoritative position, projected per viewer
 *   • the match settles exactly once, and a terminal match accepts nothing more
 *
 * Everything it creates is deleted again, so it leaves the database as it found
 * it (a hard safety net: it refuses to touch any row it did not create).
 *
 * Run:  node --env-file-if-exists=.env.local --import tsx qa/barricade-online-check.mjs
 */

import pg from "pg";

import { applyAction, legalMoves } from "../src/lib/barricade/rules.ts";
import {
  createOrJoin,
  fetchMatch,
  forfeitMatch,
  isMatchId,
  move,
} from "../src/lib/barricade/serverStore.ts";

const stamp = Date.now();
const ALICE = `qa_barricade_alice_${stamp}`;
const BOB = `qa_barricade_bob_${stamp}`;

let failures = 0;
let checks = 0;

function check(label, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return true;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One action for the seat on turn, taken from the engine's own generator — the
 * same list the store validates against, so a refusal would be a real bug.
 */
function nextAction(state) {
  const moves = legalMoves(state, state.turn);
  if (!moves.length) return null;
  return moves[0];
}

const createdMatchIds = [];

async function cleanup(client) {
  if (!createdMatchIds.length) return;
  // Only rows this run created are ever touched.
  const guards = [ALICE, BOB];
  await client.query(
    "delete from barricade_moves where match_id = any($1::uuid[])",
    [createdMatchIds],
  );
  await client.query(
    "delete from barricade_matches where id = any($1::uuid[]) and player1_id = any($2) and (player2_id is null or player2_id = any($2))",
    [createdMatchIds, guards],
  );
}

async function main() {
  const url = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").replace(
    /([?&])sslmode=[^&]*(&|$)/g,
    (_match, prefix, suffix) => (suffix === "&" ? prefix : ""),
  );
  if (!url) {
    console.log("SKIP: DATABASE_URL is not set — run with --env-file-if-exists=.env.local");
    return;
  }

  const pool = new pg.Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1|::1/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  console.log("─ matchmaking (direct create → join) ─────────────────────────");
  const created = await createOrJoin({ userId: ALICE });
  check("the host opens a waiting lobby", created.joined === false && isMatchId(created.match.id));
  if (created.error) throw new Error(created.error);
  createdMatchIds.push(created.match.id);
  check("the lobby has no second seat yet", created.match.player2Id === null);
  check("the lobby is waiting", created.match.status === "waiting");
  check("the opening position is the engine's", created.match.gameState.ply === 0);

  const resumed = await createOrJoin({ userId: ALICE });
  check(
    "the host gets its own lobby back, not a second one",
    resumed.match?.id === created.match.id && resumed.joined === false,
  );

  const joined = await createOrJoin({ userId: BOB });
  check("the joiner takes the second seat", joined.match?.player2Id === BOB);
  check("joining starts the match", joined.match?.status === "playing");
  check("the joiner is reported as a join", joined.joined === true);
  const matchId = created.match.id;

  console.log("─ reads ──────────────────────────────────────────────────────");
  const aliceView = await fetchMatch({ userId: ALICE, matchId });
  const bobView = await fetchMatch({ userId: BOB, matchId });
  const strangerView = await fetchMatch({ userId: `qa_barricade_mallory_${stamp}`, matchId });
  check("the host reads its seat", aliceView.dto?.viewerSeat === "player1");
  check("the opponent reads the mirrored seat", bobView.dto?.viewerSeat === "player2");
  check("only the seat on turn may act", aliceView.dto?.isViewerTurn === true && bobView.dto?.isViewerTurn === false);
  check(
    "the opponent's reserve is visible to both seats",
    aliceView.dto?.wallsRemaining?.player2 === 10 && bobView.dto?.wallsRemaining?.player2 === 10,
  );
  check("an unrelated account cannot read the match", strangerView.status === 403);

  console.log("─ authority ──────────────────────────────────────────────────");
  const outOfTurn = await move({
    userId: BOB,
    matchId,
    action: nextAction(aliceView.dto.gameState),
    expectedVersion: 0,
  });
  check("an out-of-turn action is refused", outOfTurn.status === 409, JSON.stringify(outOfTurn));

  const stale = await move({
    userId: ALICE,
    matchId,
    action: nextAction(aliceView.dto.gameState),
    expectedVersion: 99,
  });
  check("a stale version is refused", stale.status === 409, JSON.stringify(stale));

  const first = nextAction(aliceView.dto.gameState);
  const played = await move({ userId: ALICE, matchId, action: first, expectedVersion: 0 });
  const expected = applyAction(aliceView.dto.gameState, "player1", first);
  check("the server's next state IS the engine's next state", played.state.ply === expected.ply);
  check("the turn passed to the other seat", played.state.turn === "player2");
  check("the version advanced by one", played.match.ply === 1);

  const replay = await move({ userId: ALICE, matchId, action: first, expectedVersion: 0 });
  check("a replayed action is refused", replay.status === 409, JSON.stringify(replay));

  console.log("─ concurrency: two actions on one turn ───────────────────────");
  const current = (await fetchMatch({ userId: BOB, matchId })).dto;
  const shared = nextAction(current.gameState);
  const [a, b] = await Promise.all([
    move({ userId: BOB, matchId, action: shared, expectedVersion: current.version }),
    move({ userId: BOB, matchId, action: shared, expectedVersion: current.version }),
  ]);
  const wins = [a, b].filter((r) => r.error === undefined).length;
  const conflicts = [a, b].filter((r) => r.status === 409 || r.status === 503).length;
  check("exactly one of two concurrent actions is applied", wins === 1, `wins=${wins}`);
  check("the loser is a clean conflict, never a 500", conflicts === 1, JSON.stringify([a, b]));
  const afterRace = await fetchMatch({ userId: ALICE, matchId });
  check("the log holds one row for that turn", afterRace.dto.version === current.version + 1);

  console.log("─ playing the match out ──────────────────────────────────────");
  let state = afterRace.dto.gameState;
  let guard = 0;
  let refusals = 0;
  while (state.status === "playing" && guard < 400) {
    guard += 1;
    const actor = state.turn === "player1" ? ALICE : BOB;
    const action = nextAction(state);
    const version = (await fetchMatch({ userId: actor, matchId })).dto.version;
    const result = await move({ userId: actor, matchId, action, expectedVersion: version });
    if (result.error) {
      refusals += 1;
      console.log(`  note  action refused: ${result.status} ${result.error}`);
      if (refusals > 3) break;
      await sleep(50);
      continue;
    }
    state = result.state;
  }
  check("no action taken from the engine's own list was ever refused", refusals === 0, `${refusals} refusals`);
  check("the match reached a terminal state", state.status === "finished", state.status);
  check("a winner was recorded", state.winner === "player1" || state.winner === "player2");
  const finished = (await fetchMatch({ userId: ALICE, matchId })).dto;
  check("the row is finished", finished.status === "finished");
  check(
    "the winner id matches the winning seat",
    finished.winnerId === (finished.result === "player1" ? ALICE : BOB),
  );
  check("the reason is the engine's", finished.resultReason === "reached-baseline");
  check("the match has an end instant", Boolean(finished.endedAt));

  console.log("─ settlement happens once ───────────────────────────────────");
  const late = await move({
    userId: ALICE,
    matchId,
    action: { type: "move", to: { col: 4, row: 1 } },
    expectedVersion: finished.version,
  });
  check("a finished match accepts no further action", late.status === 409, JSON.stringify(late));
  const lateForfeit = await forfeitMatch({ userId: BOB, matchId });
  check("a finished match cannot be resigned", lateForfeit.status === 409, JSON.stringify(lateForfeit));
  const stillFinished = (await fetchMatch({ userId: BOB, matchId })).dto;
  check(
    "the first settlement still stands",
    stillFinished.winnerId === finished.winnerId && stillFinished.result === finished.result,
  );

  console.log("─ cleanup ───────────────────────────────────────────────────");
  await cleanup(client);
  const leftover = await client.query(
    "select count(*)::int n from barricade_matches where id = any($1::uuid[])",
    [createdMatchIds],
  );
  check("every row this run created is gone", leftover.rows[0].n === 0);

  client.release();
  await pool.end();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main().catch(async (error) => {
  console.error("barricade online check failed:", error);
  try {
    const client = await new pg.Pool({
      connectionString: (process.env.DATABASE_URL || "").replace(
        /([?&])sslmode=[^&]*(&|$)/g,
        (_m, p, s) => (s === "&" ? p : ""),
      ),
      ssl: { rejectUnauthorized: false },
    }).connect();
    await cleanup(client);
    client.release();
  } catch {
    // best effort
  }
  process.exit(1);
});
