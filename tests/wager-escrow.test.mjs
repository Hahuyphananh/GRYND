/**
 * wager-escrow.test.mjs
 *
 * The coin escrow rules (src/lib/tokens/wager.ts): a payout can never exceed
 * MAX_WIN_PER_MATCH or push a balance past WALLET_HARD_CAP, and every move is
 * keyed so it can only be applied once per match.
 *
 * Run:  node --import tsx --test tests/wager-escrow.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  capPayout,
  wagerLedgerKey,
  WAGER_REFERENCE,
  PAYOUT_REFERENCE,
  REFUND_REFERENCE,
} from "../src/lib/tokens/wager.ts";
import { MAX_WIN_PER_MATCH, WALLET_HARD_CAP } from "../src/lib/games/economy.ts";

const SRC = "src/lib/tokens/wager.ts";
const src = fs.readFileSync(SRC, "utf8");

test("a payout is capped by the per-match ceiling", () => {
  assert.equal(capPayout(500, 0), 500);
  assert.equal(capPayout(MAX_WIN_PER_MATCH, 0), MAX_WIN_PER_MATCH);
  assert.equal(capPayout(MAX_WIN_PER_MATCH + 1, 0), MAX_WIN_PER_MATCH);
  assert.equal(capPayout(1_000_000, 0), MAX_WIN_PER_MATCH);
});

test("a payout is capped by the wallet headroom", () => {
  assert.equal(capPayout(500, WALLET_HARD_CAP), 0);
  assert.equal(capPayout(500, WALLET_HARD_CAP - 100), 100);
  assert.equal(capPayout(500, WALLET_HARD_CAP - 1), 1);
  // A balance already at/above the cap can never be credited further.
  assert.equal(capPayout(500, WALLET_HARD_CAP + 5_000), 0);
});

test("capPayout rejects non-payments", () => {
  for (const amount of [0, -1, -500, NaN, Infinity, null, undefined, "abc"]) {
    assert.equal(capPayout(amount, 0), 0, `capPayout(${String(amount)})`);
  }
});

test("the ledger key is unique per match AND player", () => {
  assert.equal(wagerLedgerKey("m1", "user_a"), "m1:user_a");
  assert.notEqual(wagerLedgerKey("m1", "user_a"), wagerLedgerKey("m1", "user_b"));
  assert.notEqual(wagerLedgerKey("m1", "user_a"), wagerLedgerKey("m2", "user_a"));
});

// ════════════════════════════════════════════════════════════════════════
// The PvP stores escrow at join and settle through the helper
// ════════════════════════════════════════════════════════════════════════

const PAID_STORES = [
  "src/lib/keno-pvp/serverStore.js",
  "src/lib/memory-grid/serverStore.js",
  "src/lib/mines-pvp/serverStore.js",
  "src/lib/lane-rush-duel/serverStore.js",
];

test("every paid PvP store escrows both seats and settles through the ledger", () => {
  for (const file of PAID_STORES) {
    const store = fs.readFileSync(file, "utf8");
    assert.match(
      store,
      /import \{[^}]*escrowMatchWagers[^}]*\} from "[^"]*tokens\/wager"/,
      `${file} must take its escrow from the helper`,
    );
    assert.match(store, /escrowMatchWagers\(\{/, `${file} must escrow at join`);
    assert.match(store, /\bsettleEscrow\(/, `${file} must pay out through the ledger`);
    assert.match(store, /\bescrowFor\(/, `${file} must derive the pot from the stake`);
    assert.match(
      store,
      /stake: match\.stakeAmount,/,
      `${file} must escrow the match's own stake`,
    );
  }
});

// Dots-and-Boxes and Four-in-a-Row: settle module + the join route that
// escrows both seats when the guest takes the second seat.
const BOARD_GAMES = [
  {
    server: "src/lib/dotsAndBoxesServer.js",
    join: "src/app/api/dots-and-boxes/join-game/route.js",
    gameKey: "dots-and-boxes",
  },
  {
    server: "src/lib/fourInARowServer.js",
    join: "src/app/api/four-in-a-row/join-game/route.js",
    gameKey: "four-in-a-row",
  },
];

test("Dots-and-Boxes and Four-in-a-Row escrow at join and settle the pot", () => {
  for (const { server, join, gameKey } of BOARD_GAMES) {
    const store = fs.readFileSync(server, "utf8");
    const route = fs.readFileSync(join, "utf8");

    // Both stakes are taken when the second seat fills, all-or-nothing.
    assert.match(
      route,
      /import \{ escrowMatchWagers \} from "[^"]*tokens\/wager"/,
      `${join} must escrow at join`,
    );
    assert.match(route, /escrowMatchWagers\(\{/);
    assert.match(route, /stake: game\.betAmount,/);
    assert.ok(route.includes(`gameKey: "${gameKey}"`));

    // The pot is paid from that escrow, not zeroed out.
    assert.match(
      store,
      /import \{ refundWager, settlePayout \} from "[^"]*tokens\/wager"/,
      `${server} must settle through the ledger`,
    );
    assert.match(store, /const payout = isPaid/);
    assert.match(store, /2 \* bet \* \(1 - PVP_RAKE_PCT\)/);
    assert.match(store, /await settlePayout\(\{/);
    assert.ok(store.includes(`gameKey: "${gameKey}"`));
    // A draw returns both stakes through the same ledger.
    assert.match(store, /await refundWager\(\{/);
    // The retired-stakes shortcut is gone.
    assert.doesNotMatch(
      store,
      /Stakes are retired: no pot, no rake and no payout to move/,
      `${server} still zeroes the payout`,
    );
  }
});

const TOWER_ARENA = "src/lib/tower-arena/serverStore.ts";

test("Tower Arena escrows at fill, pays the pot once, and refunds on cancel", () => {
  const store = fs.readFileSync(TOWER_ARENA, "utf8");
  assert.match(
    store,
    /import \{[^}]*escrowMatchWagers[^}]*\} from "[^"]*tokens\/wager"/,
  );
  // Escrowed at lobby fill (1v1), not at create — a waiting lobby costs nothing.
  assert.match(store, /escrowMatchWagers\(\{/);
  assert.match(store, /stake: match\.wager,/);
  // The settled pot comes from the shared payout math, not a hard-coded 0.
  assert.match(store, /const isPaid = !match\.isAi && Number\(match\.wager\) > 0;/);
  assert.match(store, /computePotPrize\(\{ wager: Number\(match\.wager\) \}\)/);
  assert.doesNotMatch(
    store,
    /const isPaid = false;/,
    "Tower Arena must not settle with a dead 0 pot any more",
  );
  // The winner is actually paid, capped by the shared ceiling.
  assert.match(store, /await settlePayout\(\{/);
  assert.match(store, /gameKey: "tower-arena"/);
  // Lobby cancel / leave returns the escrowed stakes.
  assert.match(store, /await refundWager\(\{/);
  // A guest has no account to escrow from.
  assert.match(store, /Guests can only play free lobbies/);
});

// Precision: the duel is funded at the moment the two seats are paired, and
// the winner is paid out of that escrow when the match finishes.
const PRECISION_STORE = "src/lib/precision/serverStore.ts";
const PRECISION_FINISH = "src/lib/precision/finishMatch.ts";
const PRECISION_MATCHMAKING = "src/lib/precision/matchmaking.ts";
const PRECISION_CREATE_LOBBY = "src/app/api/precision/create-lobby/route.ts";

test("Precision escrows both seats at pairing and pays the pot on finish", () => {
  const store = fs.readFileSync(PRECISION_STORE, "utf8");
  const finish = fs.readFileSync(PRECISION_FINISH, "utf8");
  const matchmaking = fs.readFileSync(PRECISION_MATCHMAKING, "utf8");

  // The escrow rides the PAIRING transaction, so a match row can never exist
  // without the two stakes behind it (both entry points share this helper).
  assert.match(
    store,
    /import \{ escrowMatchWagers, refundMatchWagers \} from "[^"]*tokens\/wager"/,
  );
  assert.match(store, /export async function createMatchForPairing\(/);
  assert.match(store, /await escrowMatchWagers\(\{/);
  assert.match(store, /stake: input\.wager,/);
  assert.match(store, /gameKey: "precision"/);

  // A pairing that cannot be funded is refused and rolled back — never a
  // half-created match — and the caller gets the reason, not a 500.
  assert.match(store, /class PrecisionEscrowError extends Error/);
  assert.match(store, /throw new PrecisionEscrowError\(/);
  assert.match(matchmaking, /instanceof PrecisionEscrowError/);
  assert.match(matchmaking, /status: "insufficient"/);
  assert.match(
    fs.readFileSync(PRECISION_CREATE_LOBBY, "utf8"),
    /result\.status === "insufficient"/,
  );

  // The finish helper pays the real pot (2 × stake, minus the shared rake)
  // through the ledger.
  assert.match(finish, /PRECISION_PAYOUT_MULTIPLIER = 2 \* PVP_WINNER_SHARE/);
  assert.match(finish, /const payout = Number\(/);
  assert.match(finish, /await settlePayout\(\{/);
  assert.match(finish, /gameKey: "precision",/);
  assert.doesNotMatch(
    finish,
    /STAKES ARE RETIRED/,
    "Precision must not settle with a dead 0 pot any more",
  );
});

test("Precision refunds a void match instead of stranding the stakes", () => {
  const store = fs.readFileSync(PRECISION_STORE, "utf8");

  // A resign declares no winner, so BOTH stakes go back — and the match is
  // stamped as settled so a late `/finish-match` cannot pay a "winner" on top
  // of the refund.
  assert.match(store, /write\.payoutProcessedAt = new Date\(now\)/);
  assert.match(store, /await refundMatchWagers\(\{/);
  assert.match(
    store,
    /resignMatch[\s\S]{0,6000}await refundMatchWagers\(\{/,
    "a resigned match must return both stakes",
  );
  // Teardown hands the escrow back BEFORE deleting the only row that knows
  // who paid.
  assert.match(
    store,
    /removePrecisionMatch[\s\S]{0,2000}await refundMatchWagers\(\{/,
  );
  // The abandoned sweep refunds, then reclaims. A match being mutated right
  // now is stepped over rather than swept mid-transition.
  assert.match(store, /skipLocked: true/);
  assert.match(
    store,
    /reclaimAbandonedMatches[\s\S]{0,2500}await refundMatchWagers\(\{/,
  );
  // …and a finished match that still owes a winner a payout is left alone
  // (deleting it would destroy the only pointer to their unclaimed prize).
  assert.match(store, /isNotNull\(precisionMatches\.payoutProcessedAt\)/);
});

test("RPS's payout is the pot minus the shared rake", async () => {
  const { rpsPvpPayout } = await import("../src/lib/rps-pvp/serverStore.js");
  const { PVP_RAKE_PCT } = await import("../src/lib/games/economy.ts");
  assert.equal(rpsPvpPayout(0), 0, "a free match pays nothing");
  assert.equal(rpsPvpPayout(10), 19); // 2 × 10 × 0.95
  assert.equal(rpsPvpPayout(100), 190);
  for (const stake of [1, 3, 7, 25, 100]) {
    const pot = 2 * stake;
    const payout = rpsPvpPayout(stake);
    assert.ok(payout <= pot, `stake ${stake} paid ${payout} out of a ${pot} pot`);
    assert.equal(payout, Number((pot * (1 - PVP_RAKE_PCT)).toFixed(2)));
  }
});

test("Precision's payout is the pot minus the shared rake", async () => {
  const { PRECISION_PAYOUT_MULTIPLIER } = await import(
    "../src/lib/precision/finishMatch.ts"
  );
  const { PVP_WINNER_SHARE } = await import("../src/lib/games/economy.ts");
  // 2 × (1 − 5%) — the same 1.9× the retired-stakes era promised, now funded
  // by two real stakes instead of nothing.
  assert.equal(PRECISION_PAYOUT_MULTIPLIER, 2 * PVP_WINNER_SHARE);
  assert.equal(Number(PRECISION_PAYOUT_MULTIPLIER.toFixed(2)), 1.9);

  for (const stake of [1, 5, 10, 100]) {
    const pot = 2 * stake;
    const payout = Number((stake * PRECISION_PAYOUT_MULTIPLIER).toFixed(2));
    assert.equal(payout, Number((pot * PVP_WINNER_SHARE).toFixed(2)));
    // Coins are conserved: the winner is paid out of the pot, never beyond it.
    assert.ok(payout <= pot, `stake ${stake} paid ${payout} out of a ${pot} pot`);
  }
});

// RPS: the pot is escrowed when the second seat joins and paid out on whichever
// path ends the match (the deciding round, or a forfeit).
const RPS_STORE = "src/lib/rps-pvp/serverStore.js";
const RPS_JOIN = "src/app/api/rps/pvp/join/route.js";
const RPS_CHOOSE = "src/app/api/rps/pvp/choose/route.js";
const RPS_STATUS = "src/app/api/rps/pvp/status/route.js";

test("RPS escrows both seats at join and pays the pot on the terminal write", () => {
  const store = fs.readFileSync(RPS_STORE, "utf8");
  const join = fs.readFileSync(RPS_JOIN, "utf8");
  const choose = fs.readFileSync(RPS_CHOOSE, "utf8");
  const status = fs.readFileSync(RPS_STATUS, "utf8");

  // Both stakes are taken when the second player takes the seat, and a seat
  // that cannot pay refuses the join instead of half-funding the match.
  assert.match(
    join,
    /import \{ escrowMatchWagers \} from "[^"]*tokens\/wager"/,
  );
  assert.match(join, /await escrowMatchWagers\(\{/);
  assert.match(join, /stake: game\.betAmount,/);
  assert.match(join, /clerkIds: \[game\.player1Id, userId\]/);
  // A refused join is a 400 with the reason, never a 500.
  assert.match(join, /throw new Error\(escrow\.error \|\| "Insufficient coins"\)/);
  assert.match(join, /\{ status: 400 \}/);

  // ONE pot helper, used by both settlement paths, derived from the shared
  // rake — no second hard-coded multiplier to drift out of step.
  assert.match(store, /export function rpsPvpPayout\(betAmount\)/);
  assert.match(store, /2 \* stake \* PVP_WINNER_SHARE/);
  assert.match(store, /export async function payRpsPvpWinner\(/);
  assert.match(store, /await settlePayout\(\{/);
  assert.match(store, /gameKey: "rps-pvp"/);
  assert.doesNotMatch(
    store,
    /winnerPayout: 0/,
    "a forfeit must pay the winner the pot, not zero",
  );
  // The deciding round settles through the same helper, inside its transaction.
  assert.match(choose, /const winnerPayout = await payRpsPvpWinner\(\{/);
  assert.match(choose, /tx,/);
  // What the client is SHOWN comes from the same helper as what is paid.
  assert.match(status, /const winnerPayout = rpsPvpPayout\(betAmount\)/);
  assert.doesNotMatch(status, /HOUSE_EDGE_PERCENT/);
});

test("the ledger never pays a match it has voided, nor refunds one it has paid", () => {
  assert.match(src, /export async function refundMatchWagers\(/);
  // Refunding a seat that already won on the match would double-credit it…
  assert.match(
    src,
    /if \(await ledgerRowExists\(tx, PAYOUT_REFERENCE, referenceId\)\) \{\s*\n\s*return \{ ok: true, balance, applied: false \};/,
    "refunding a seat that already won on the same match would double-credit it",
  );
  // …and paying a seat whose stake was already given BACK would pay the winner
  // out of money the house returned: two terminal paths racing on one match
  // must never both move coins.
  assert.match(
    src,
    /if \(await ledgerRowExists\(tx, REFUND_REFERENCE, referenceId\)\) \{\s*\n\s*return \{ ok: true, balance, applied: false \};/,
    "a payout must be refused once the match's stakes were refunded",
  );
});

// Odds: the pot is escrowed when the second seat joins and paid on whichever
// path ends the match; a match that ends without a winner is voided back to
// both seats.
const ODDS_STORE = "src/lib/odds-pvp/serverStore.ts";
const ODDS_JOIN = "src/app/api/odds/join/route.ts";
const ODDS_PICK = "src/app/api/odds/pvp/pick/route.ts";
const ODDS_FORFEIT = "src/app/api/odds/pvp/forfeit/route.ts";
const ODDS_CLEANUP = "src/app/api/odds/pvp/cleanup/route.ts";
const ODDS_STATUS = "src/app/api/odds/pvp/status/route.ts";

test("Odds escrows both seats at join and settles every ending through one helper", () => {
  const store = fs.readFileSync(ODDS_STORE, "utf8");
  const join = fs.readFileSync(ODDS_JOIN, "utf8");
  const pick = fs.readFileSync(ODDS_PICK, "utf8");
  const forfeit = fs.readFileSync(ODDS_FORFEIT, "utf8");
  const cleanup = fs.readFileSync(ODDS_CLEANUP, "utf8");
  const status = fs.readFileSync(ODDS_STATUS, "utf8");

  // Both stakes are taken when the second player takes the seat…
  assert.match(join, /import \{ escrowMatchWagers \} from "[^"]*tokens\/wager"/);
  assert.match(join, /await escrowMatchWagers\(\{/);
  assert.match(join, /clerkIds: \[game\.player1Id, userId\]/);
  assert.match(join, /stake: game\.wager,/);
  // …and a seat that cannot pay is a 4xx with the reason, not a 500.
  assert.match(join, /throw Object.assign\(\s*\n\s*new Error\(escrow\.error \|\| "Insufficient coins"\),/);
  assert.match(join, /const status = error\?\.status === 400 \? 400 : 500;/);

  // ONE pot helper, derived from the shared rake (no second literal 1.9).
  assert.match(store, /export function oddsPvpPayout\(wager: unknown\)/);
  assert.match(store, /2 \* stake \* PVP_WINNER_SHARE/);
  assert.match(store, /export async function payOddsPvpWinner\(/);
  assert.match(store, /gameKey: "odds-pvp"/);
  assert.match(store, /export async function refundOddsPvpStakes\(/);
  assert.match(store, /refundMatchWagers\(\{/);

  // Every terminal path goes through it: the deciding round, a timeout forfeit,
  // an explicit forfeit and the inactivity cleanup.
  const winnersPaid = pick.match(/await payOddsPvpWinner\(\{/g) ?? [];
  assert.equal(winnersPaid.length, 2, "pick must pay on the round win and on the timeout forfeit");
  assert.match(forfeit, /await payOddsPvpWinner\(\{/);
  assert.match(cleanup, /await payOddsPvpWinner\(\{/);
  // A tie and an abandoned game are VOIDED: both stakes back, never stranded.
  assert.match(pick, /await refundOddsPvpStakes\(\{/);
  assert.match(cleanup, /await refundOddsPvpStakes\(\{/);
  // No dead `payout = 0` left on a settlement path.
  assert.doesNotMatch(pick, /const payout = 0;/);
  assert.doesNotMatch(forfeit, /const payout = 0;/);
  // What the client is shown comes from the same helper as what is paid.
  assert.match(status, /payout: oddsPvpPayout\(game\.wager\)/);
  assert.doesNotMatch(status, /game\.wager \* 1\.9/);
});

test("Odds's payout is the pot minus the shared rake", async () => {
  const { oddsPvpPayout } = await import("../src/lib/odds-pvp/serverStore.ts");
  const { PVP_RAKE_PCT } = await import("../src/lib/games/economy.ts");
  assert.equal(oddsPvpPayout(0), 0, "a free match pays nothing");
  assert.equal(oddsPvpPayout(10), 19);
  for (const stake of [1, 4, 20, 100]) {
    const pot = 2 * stake;
    const payout = oddsPvpPayout(stake);
    assert.ok(payout <= pot, `stake ${stake} paid ${payout} out of a ${pot} pot`);
    assert.equal(payout, Number((pot * (1 - PVP_RAKE_PCT)).toFixed(2)));
  }
});

test("the escrow helper guards the balance and is idempotent per match", () => {
  // No negative balance: the debit refuses a wager the player cannot cover.
  assert.match(src, /Infinity|Insufficient coins/);
  assert.match(src, /balance < amount/);
  assert.match(src, /Insufficient coins/);
  // Atomic, guarded UPDATE shape — never a read-then-write of a raw balance.
  assert.match(src, /sql`\$\{users\.balance\} - \$\{amount\}`/);
  assert.match(src, /sql`\$\{users\.balance\} \+ \$\{credit\}`/);
  // Idempotency: every move is keyed and skips when the row already exists.
  assert.match(src, /ledgerRowExists\(/);
  for (const ref of [WAGER_REFERENCE, PAYOUT_REFERENCE, REFUND_REFERENCE]) {
    assert.ok(src.includes(ref), `missing ledger reference ${ref}`);
  }
  // Each of the three moves locks the player's row before writing.
  assert.ok(
    (src.match(/\.for\("update"\)/g) || []).length >= 1,
    "the escrow must lock the player's row",
  );
  // Neither a refund nor a payout may MINT: both require the debit row that
  // funded the match (so settling a never-escrowed row pays nothing).
  const fundedGuards =
    src.match(
      /if \(!\(await ledgerRowExists\(tx, WAGER_REFERENCE, referenceId\)\)\) \{\s*\n\s*return \{ ok: true, balance, applied: false \};/g,
    ) || [];
  assert.equal(
    fundedGuards.length,
    2,
    "both settlePayout and refundWager must require the funding debit row",
  );
});

// ════════════════════════════════════════════════════════════════════════
// The games whose result the SERVER decides
//
// UNO (hand emptiness in the row), Dice Flush (the shared dice engine) and
// Chess (chess.js move validation plus a server-recomputed clock) all settle
// from state the server owns, so their stake can be real. Each escrows BOTH
// seats when the second one fills — a waiting lobby costs nothing — and the
// winner is paid out of that escrow on every terminal path.
// ════════════════════════════════════════════════════════════════════════

const UNO_JOIN = "src/app/api/uno/join-online/route.js";
const UNO_SETTLE = "src/app/api/uno/determine-winner/route.js";
const UNO_RESIGN = "src/app/api/uno/resign/route.js";

test("UNO escrows both seats at join and pays the winner on settle and resign", () => {
  const join = fs.readFileSync(UNO_JOIN, "utf8");
  const settle = fs.readFileSync(UNO_SETTLE, "utf8");
  const resign = fs.readFileSync(UNO_RESIGN, "utf8");

  // Both stakes are taken the moment the seat fills, all-or-nothing, and the
  // host is resolved from the row (the row stores ACCOUNT ids, the ledger keys
  // on CLERK ids).
  assert.match(
    join,
    /import \{ escrowMatchWagers \} from "[^"]*tokens\/wager"/,
    `${UNO_JOIN} must escrow at join`,
  );
  assert.match(join, /await escrowMatchWagers\(\{/);
  assert.match(join, /clerkIds: \[host\?\.clerkId, userId\]/);
  assert.match(join, /stake: openGame\.betAmount,/);
  assert.ok(join.includes('gameKey: "uno"'));
  // A seat that cannot cover the stake is a 400 with the reason, not a 500.
  assert.match(join, /if \(!escrow\.ok\)/);
  assert.match(join, /if \(error\?\.status === 400\)/);

  // Both terminal paths pay through the SHARED pot helper, inside the same
  // transaction as the result that earned it.
  assert.match(settle, /import \{ payPvpPot \} from "[^"]*tokens\/pvpPot"/);
  assert.match(settle, /payout = await payPvpPot\(\{/);
  assert.match(settle, /winnerClerkId: winnerUser\.clerkId,/);
  assert.ok(settle.includes('gameKey: "uno"'));
  // …and only the transaction that CLAIMED the settle may pay.
  assert.match(settle, /if \(finalized\.length === 0\) return false;/);

  assert.match(resign, /import \{ payPvpPot \} from "[^"]*tokens\/pvpPot"/);
  assert.match(resign, /await payPvpPot\(\{/);
  assert.match(resign, /winnerClerkId: opponent\?\.clerkId,/);

  // No dead 0-payout settlement is left on any money path.
  assert.doesNotMatch(settle, /const payout = "0\.00";/);
  assert.doesNotMatch(resign, /STAKES ARE RETIRED/);
});

const DF_LIB = "src/app/api/dice-flush/_lib.js";
const DF_JOIN = "src/app/api/dice-flush/join/route.js";
const DF_RESIGN = "src/app/api/dice-flush/resign/route.js";

test("Dice Flush escrows both seats at join and pays the pot on settle and resign", () => {
  const lib = fs.readFileSync(DF_LIB, "utf8");
  const join = fs.readFileSync(DF_JOIN, "utf8");
  const resign = fs.readFileSync(DF_RESIGN, "utf8");

  // ONE escrow helper for the room, taking both seats at the moment the second
  // player joins.
  assert.match(lib, /import \{ escrowMatchWagers \} from "[^"]*tokens\/wager"/);
  assert.match(lib, /import \{ payPvpPot \} from "[^"]*tokens\/pvpPot"/);
  assert.match(lib, /export async function escrowRoomStakes\(tx, room, joinerId, creatorId\)/);
  assert.match(lib, /await escrowMatchWagers\(\{/);
  assert.match(lib, /clerkIds: \[creatorId, joinerId\]/);
  assert.match(lib, /stake,\s*\n\s*matchId: room\.id,/);
  assert.ok(lib.includes('gameKey: "dice-flush"'));

  assert.match(join, /await escrowRoomStakes\(tx, room, userId, creatorId\)/);
  assert.doesNotMatch(join, /lockBalance/);

  // The end-of-match settlement and a resignation both pay through the shared
  // helper — the settlement guarded by the room's own `finished` claim, and the
  // resignation by its conditional UPDATE, so neither can pay twice.
  assert.match(lib, /payout = await payPvpPot\(\{/);
  // The resignation claims the room with a conditional UPDATE before paying,
  // so only the first resignation from a live room can move coins.
  assert.match(resign, /const \[claimed\] = await tx\.update\(diceFlushRooms\)/);
  assert.match(resign, /await payPvpPot\(\{/);
  assert.match(resign, /winnerClerkId: winner\.userId,/);
  // An AI practice room was never escrowed and pays nothing.
  assert.match(lib, /const staked = !isAiMatch && Number\(roomRow\.wager\) > 0;/);
  assert.match(resign, /const staked = !isAiMatch && Number\(room\.wager\) > 0;/);
  assert.doesNotMatch(lib, /STAKES ARE RETIRED: there is no pot to pay out or rake/);
});

const CHESS_JOIN = "src/app/api/chess/join-game/route.js";
const CHESS_MOVE = "src/app/api/chess/move/route.js";
const CHESS_STATE = "src/app/api/chess/game-state/route.js";
const CHESS_END = "src/app/api/chess/end-game/route.js";

test("Chess escrows both seats at join and pays the act the server derived", () => {
  const join = fs.readFileSync(CHESS_JOIN, "utf8");
  const move = fs.readFileSync(CHESS_MOVE, "utf8");
  const state = fs.readFileSync(CHESS_STATE, "utf8");
  const end = fs.readFileSync(CHESS_END, "utf8");

  // Both stakes are taken when the second seat fills, all-or-nothing.
  assert.match(
    join,
    /import \{ escrowMatchWagers \} from "[^"]*tokens\/wager"/,
    `${CHESS_JOIN} must escrow at join`,
  );
  assert.match(join, /await escrowMatchWagers\(\{/);
  assert.match(join, /clerkIds: \[game\.playerWhiteId, userId\]/);
  assert.match(join, /stake: Number\(game\.betAmount\) \|\| 0,/);
  assert.ok(join.includes('gameKey: "chess"'));
  assert.match(join, /if \(!escrow\.ok\)/);

  // Every terminal path pays: the checkmate the server validated, the clock
  // timeout it recomputed, and the forfeit it derived from the row.
  assert.match(move, /import \{ payPvpPot \} from "[^"]*tokens\/pvpPot"/);
  assert.match(move, /await payPvpPot\(\{/);
  assert.ok(move.includes('gameKey: "chess"'));
  assert.match(state, /await payPvpPot\(\{/);
  assert.match(end, /await payPvpPot\(\{/);

  // The winner is the SERVER's winner, never the request's: the checkmate path
  // uses `userId` only after chess.js ruled the move legal, and the timeout
  // path uses the winner recomputed inside the lock.
  assert.match(state, /winnerClerkId: lockedWinnerId,/);
  assert.match(end, /winnerClerkId: opponentId,/);

  // A DRAW is void, not a stranded pot: both stakes go back through the same
  // ledger (which refuses it if the match was already paid).
  assert.match(move, /await refundMatchWagers\(\{/);
  assert.match(move, /else if \(isDraw && !lockedGame\.isAiGame && stake > 0\)/);

  // No dead 0-payout left behind on a settlement path.
  assert.doesNotMatch(state, /const winnerPayout = 0;/);
  assert.doesNotMatch(end, /const winnerPayout = 0;/);
});

// Pool Masters and Hex Duel are deliberately NOT staked: their match winner is
// declared by the CLIENT (pool pushes `gameState.winner` through
// `/api/pool/update-state`; `/api/hex-duel/multiplayer/end` reads `winner` off
// the request body). Attaching a coin stake to a client-declared result would
// be a coin mint, so both keep settlement on server-derived endings only until
// their result moves to the server.
test("Pool and Hex Duel stay unstaked while their winner is client-declared", () => {
  const poolResign = fs.readFileSync("src/app/api/pool/resign/route.ts", "utf8");
  const hexEnd = fs.readFileSync("src/app/api/hex-duel/multiplayer/end/route.ts", "utf8");
  // Neither pays a pot nor escrows one.
  for (const [file, src] of [
    ["src/app/api/pool/resign/route.ts", poolResign],
    ["src/app/api/hex-duel/multiplayer/end/route.ts", hexEnd],
  ]) {
    assert.doesNotMatch(src, /payPvpPot|settlePayout\(/, `${file} must not move a pot`);
    assert.doesNotMatch(src, /escrowMatchWagers/, `${file} must not escrow`);
  }
  // The client-declared winner is still the reason — pin it so the day it moves
  // server-side is the day this test has to change.
  assert.match(hexEnd, /winner = typeof body\.winner === "string" \? body\.winner : null;/);
  assert.match(hexEnd, /if \(winner !== "player1" && winner !== "player2"\)/);
});
