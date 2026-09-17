import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * Security tests for poker leave-game wallet minting vulnerability.
 *
 * Pentest finding: Authenticated users could mint arbitrary wallet balance
 * through poker leave settlement by supplying a fake stack value for any
 * public game without verifying seat ownership or using server-side stack.
 *
 * Mitigation: The route now:
 *   1. Verifies the user occupies a seat before crediting
 *   2. Uses server-side stack value (userSeat.stack), not client-supplied
 *   3. Only credits for public games (private games remain play money)
 */

function readRoute() {
  return fs.readFileSync("src/app/api/poker/leave-game/route.js", "utf8");
}

test("poker leave-game enforces authentication", () => {
  const route = readRoute();
  
  // Must call auth() and check userId
  assert.match(
    route,
    /await\s+auth\(\)/,
    "route must call auth() to authenticate the caller"
  );
  
  assert.match(
    route,
    /if\s*\(\s*!userId\s*\)/,
    "route must check for missing userId"
  );
  
  assert.match(
    route,
    /Unauthorized/,
    "route must return Unauthorized for unauthenticated requests"
  );
  
  assert.match(
    route,
    /status:\s*401/,
    "route must return 401 status for unauthenticated requests"
  );
});

test("poker leave-game verifies seat ownership before crediting balance", () => {
  const route = readRoute();
  
  // Must find the user's seat to verify participation
  assert.match(
    route,
    /userSeat\s*=\s*seats\.find\(/,
    "route must find the user's seat to verify participation"
  );
  
  assert.match(
    route,
    /seat\?\.clerkId\s*===\s*userId/,
    "route must match seat clerkId against authenticated userId"
  );
  
  // Credit must be conditional on userSeat existence
  assert.match(
    route,
    /if\s*\(\s*userSeat\s*&&/,
    "route must only credit balance if userSeat exists (user is seated)"
  );
});

test("poker leave-game uses server-side stack value, not client-supplied", () => {
  const route = readRoute();
  
  // Must retrieve stack from userSeat (server-side), not from request body
  assert.match(
    route,
    /userSeat\.stack/,
    "route must use server-side stack from userSeat"
  );
  
  // The cashOutAmount calculation must happen AFTER finding userSeat
  // and must use userSeat.stack, not body.stack
  const userSeatIndex = route.indexOf("userSeat = seats.find(");
  const cashOutIndex = route.indexOf("cashOutAmount");
  
  assert.ok(
    userSeatIndex > 0 && cashOutIndex > userSeatIndex,
    "cashOutAmount must be calculated after finding userSeat"
  );
  
  // Verify we're using userSeat.stack for the amount
  const cashOutLine = route
    .split("\n")
    .find((line) => line.includes("cashOutAmount") && line.includes("Number"));
  
  assert.ok(
    cashOutLine && cashOutLine.includes("userSeat.stack"),
    "cashOutAmount must be derived from userSeat.stack, not request body"
  );
  
  // Ensure body.stack is NOT used for crediting
  const creditSection = route.substring(
    route.indexOf("// Credit remaining stack"),
    route.indexOf("const updatedSeats")
  );
  
  assert.doesNotMatch(
    creditSection,
    /body\?\.stack/,
    "route must NOT use client-supplied body.stack for crediting balance"
  );
});

test("poker leave-game only credits for public games", () => {
  const route = readRoute();
  
  // Credit must be conditional on !game.isPrivate
  assert.match(
    route,
    /!game\.isPrivate/,
    "route must only credit balance for public games (not private)"
  );
  
  // The comment should explain why private games don't credit
  assert.match(
    route,
    /private games.*virtual chips|play money/i,
    "route should document that private games use play money"
  );
});

test("poker leave-game validates positive amount before crediting", () => {
  const route = readRoute();
  
  // Must check cashOutAmount > 0 before updating balance
  assert.match(
    route,
    /if\s*\(\s*cashOutAmount\s*>\s*0/,
    "route must validate cashOutAmount is positive before crediting"
  );
});

test("poker leave-game security comment documents the fix", () => {
  const route = readRoute();
  
  // Must have security comment explaining the mitigation
  assert.match(
    route,
    /SECURITY:/i,
    "route must have SECURITY comment documenting the fix"
  );
  
  assert.match(
    route,
    /verify.*participation|occupies.*seat/i,
    "security comment must mention verifying participation/seat ownership"
  );
  
  assert.match(
    route,
    /server-side.*stack/i,
    "security comment must mention using server-side stack value"
  );
});

test("poker leave-game finds user seat before processing seats array", () => {
  const route = readRoute();
  
  // The seats array must be extracted before finding userSeat
  const seatsArrayIndex = route.indexOf("const seats = Array.isArray(game.players)");
  const userSeatIndex = route.indexOf("const userSeat = seats.find(");
  
  assert.ok(
    seatsArrayIndex > 0 && userSeatIndex > seatsArrayIndex,
    "seats array must be extracted before finding userSeat"
  );
  
  // userSeat must be found BEFORE the credit logic
  const creditIndex = route.indexOf("// Credit remaining stack");
  
  assert.ok(
    userSeatIndex > 0 && creditIndex > userSeatIndex,
    "userSeat must be found before credit logic executes"
  );
});

test("poker leave-game maintains seat cleanup logic", () => {
  const route = readRoute();
  
  // Seat cleanup must still happen (clearing clerkId for user's seats)
  assert.match(
    route,
    /updatedSeats\s*=\s*seats\.map/,
    "route must still clean up user's seats"
  );
  
  assert.match(
    route,
    /seat\?\.clerkId\s*!==\s*userId/,
    "route must preserve seats not belonging to the user"
  );
  
  assert.match(
    route,
    /clerkId:\s*null/,
    "route must clear clerkId when removing user from seat"
  );
});

test("poker leave-game balance update uses SQL increment", () => {
  const route = readRoute();
  
  // Must use SQL increment to avoid race conditions
  assert.match(
    route,
    /sql`.*\$\{users\.balance\}\s*\+\s*\$\{cashOutAmount\}`/,
    "route must use SQL increment for balance update to avoid race conditions"
  );
  
  assert.match(
    route,
    /\.update\(users\)/,
    "route must update users table"
  );
  
  assert.match(
    route,
    /\.where\(eq\(users\.clerkId,\s*userId\)\)/,
    "route must update balance for the authenticated user only"
  );
});

test("poker leave-game does not allow balance minting for non-participants", () => {
  const route = readRoute();
  
  // The critical fix: userSeat must exist for any balance credit
  // This prevents non-participants from minting balance
  const creditSection = route.substring(
    route.indexOf("// Credit remaining stack"),
    route.indexOf("const updatedSeats")
  );
  
  // All balance updates must be inside the userSeat check
  const balanceUpdateMatch = creditSection.match(/\.update\(users\)/g);
  
  assert.ok(
    balanceUpdateMatch && balanceUpdateMatch.length === 1,
    "there must be exactly one balance update in the credit section"
  );
  
  // The update must be nested inside the userSeat && !game.isPrivate check
  const lines = creditSection.split("\n");
  let foundIfUserSeat = false;
  let foundBalanceUpdate = false;
  let indentAtIf = 0;
  let indentAtUpdate = 0;
  
  for (const line of lines) {
    if (line.includes("if") && line.includes("userSeat") && line.includes("!game.isPrivate")) {
      foundIfUserSeat = true;
      indentAtIf = line.search(/\S/);
    }
    if (foundIfUserSeat && line.includes(".update(users)")) {
      foundBalanceUpdate = true;
      indentAtUpdate = line.search(/\S/);
    }
  }
  
  assert.ok(
    foundIfUserSeat && foundBalanceUpdate && indentAtUpdate > indentAtIf,
    "balance update must be nested inside the userSeat && !game.isPrivate conditional"
  );
});

test("poker leave-game prevents client-controlled stack exploitation", () => {
  const route = readRoute();
  
  // Verify the exploit path is closed:
  // 1. Client cannot supply arbitrary stack value
  // 2. Server-side stack is authoritative
  // 3. Non-participants get no credit
  
  // Find the section where cashOutAmount is calculated
  const cashOutSection = route.substring(
    route.indexOf("const userSeat = seats.find("),
    route.indexOf("const updatedSeats")
  );
  
  // In the fixed version, body.stack should NOT appear in this section
  assert.doesNotMatch(
    cashOutSection,
    /body\?\.stack/,
    "client-supplied body.stack must not be used in credit calculation"
  );
  
  // userSeat.stack must be the source of truth
  assert.match(
    cashOutSection,
    /Number\(userSeat\.stack\)/,
    "server-side userSeat.stack must be the source of truth for credit amount"
  );
});

test("poker join-public route has separate accounting issue (documented)", () => {
  // This test documents the separate issue mentioned in the pentest finding:
  // join-public assigns a default stack without wallet debit.
  // This is a separate accounting defect but not required for the leave-game exploit.
  
  const joinPublicRoute = fs.readFileSync(
    "src/app/api/poker/join-public/route.js",
    "utf8"
  );
  
  // Document that join-public assigns stack without debit
  assert.match(
    joinPublicRoute,
    /stack:\s*s\.stack\s*\?\?\s*1000/,
    "join-public assigns default stack (separate accounting issue)"
  );
  
  // Note: This test documents the issue but doesn't verify a fix,
  // as the primary vulnerability is in leave-game.
  // A complete fix would require join-public to debit the wallet
  // when assigning the initial stack for public games.
});
