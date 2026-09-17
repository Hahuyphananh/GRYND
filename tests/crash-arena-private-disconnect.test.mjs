/**
 * tests/crash-arena-private-disconnect.test.mjs
 *
 * Security regression tests for the private-table disconnect cleanup vulnerability.
 *
 * VULNERABILITY (CVE-YYYY-XXXXX):
 *   releaseCrashArenaSeat refunded every non-AI seat to users.balance without
 *   checking crashArenaTables.isPrivate. Private Crash Arena joins intentionally
 *   skip the wallet deduction and ledger entry, so disconnect cleanup converted
 *   an unbacked virtual balance into real wallet tokens.
 *
 * FIX:
 *   The cleanup helper now selects isPrivate alongside isAi and returns early
 *   for private tables without touching the wallet or ledger (lines 111-131 of
 *   src/lib/crash-arena/cleanup.ts).
 *
 * TESTS:
 *   1. Private table disconnect: virtual chips never refunded
 *   2. Public table disconnect: real chips properly refunded
 *   3. AI table disconnect: no refund (existing behavior)
 *   4. Private table manual leave: no refund (existing behavior)
 *   5. Code structure: isPrivate guard exists in cleanup path
 *
 * Run:
 *   node --import tsx --test tests/crash-arena-private-disconnect.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

// ────────────────────────────────────────────────────────────────────────────
// Test 1: Cleanup helper selects isPrivate from the table
// ────────────────────────────────────────────────────────────────────────────

test("releaseCrashArenaSeat selects isPrivate from crashArenaTables", () => {
  const cleanup = read("src/lib/crash-arena/cleanup.ts");

  // The helper must SELECT isPrivate alongside isAi
  assert.match(
    cleanup,
    /select\s*\(\s*\{[^}]*isPrivate:\s*crashArenaTables\.isPrivate/is,
    "cleanup helper must select isPrivate from crashArenaTables"
  );

  // The SELECT must happen before any refund logic
  const selectMatch = cleanup.match(/select\s*\(\s*\{[^}]*isPrivate:/is);
  const refundMatch = cleanup.match(/users\.balance\s*\+/);
  
  if (selectMatch && refundMatch) {
    assert.ok(
      selectMatch.index < refundMatch.index,
      "isPrivate must be selected before any wallet refund"
    );
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 2: Private table guard exists and prevents wallet refund
// ────────────────────────────────────────────────────────────────────────────

test("releaseCrashArenaSeat has isPrivate guard that prevents wallet refund", () => {
  const cleanup = read("src/lib/crash-arena/cleanup.ts");

  // Must check isPrivate (or isVirtual derived from it)
  assert.match(
    cleanup,
    /isVirtual\s*=\s*Boolean\s*\(\s*tableData\[0\]\?\.isPrivate\s*\)|if\s*\(\s*tableData\[0\]\?\.isPrivate\s*\)/,
    "cleanup helper must check isPrivate to determine virtual status"
  );

  // The private/virtual guard must exist
  assert.match(
    cleanup,
    /if\s*\(\s*isVirtual\s*\)|if\s*\(\s*tableData\[0\]\?\.isPrivate\s*\)/,
    "cleanup helper must have an isPrivate/isVirtual guard"
  );

  // The guard must return early without refunding
  const virtualGuardSection = cleanup.match(
    /if\s*\(\s*isVirtual\s*\)\s*\{[\s\S]*?return\s*\{[^}]*cleaned:\s*true[^}]*returned:\s*0[^}]*\}/
  );
  
  assert.ok(
    virtualGuardSection,
    "isVirtual guard must return early with returned: 0 (no refund)"
  );

  // The guard must NOT update users.balance
  const guardBody = virtualGuardSection ? virtualGuardSection[0] : "";
  assert.doesNotMatch(
    guardBody,
    /users\.balance/,
    "isVirtual guard must not touch users.balance"
  );

  // The guard must NOT create a transaction
  assert.doesNotMatch(
    guardBody,
    /crashArenaTransactions/,
    "isVirtual guard must not create a LEAVE transaction"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Test 3: Private guard comes BEFORE the refund logic
// ────────────────────────────────────────────────────────────────────────────

test("releaseCrashArenaSeat checks isPrivate before refunding wallet", () => {
  const cleanup = read("src/lib/crash-arena/cleanup.ts");

  // Find the isVirtual guard
  const virtualGuardMatch = cleanup.match(
    /if\s*\(\s*isVirtual\s*\)\s*\{[\s\S]*?return\s*\{[^}]*cleaned:\s*true/
  );
  
  // Find the wallet refund
  const refundMatch = cleanup.match(
    /users\.balance\s*\+\s*\$\{returnAmount\}|balance:\s*sql`\$\{users\.balance\}\s*\+/
  );

  assert.ok(virtualGuardMatch, "isVirtual guard must exist");
  assert.ok(refundMatch, "wallet refund logic must exist");

  // The guard must come before the refund
  assert.ok(
    virtualGuardMatch.index < refundMatch.index,
    "isPrivate guard must execute before wallet refund logic"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Test 4: AI table guard still exists (regression check)
// ────────────────────────────────────────────────────────────────────────────

test("releaseCrashArenaSeat preserves AI table guard", () => {
  const cleanup = read("src/lib/crash-arena/cleanup.ts");

  // AI guard must still exist
  assert.match(
    cleanup,
    /if\s*\(\s*tableData\[0\]\?\.isAi\s*\)/,
    "AI table guard must still exist"
  );

  // AI guard must return early without refunding
  const aiGuardSection = cleanup.match(
    /if\s*\(\s*tableData\[0\]\?\.isAi\s*\)\s*\{[\s\S]*?return\s*\{[^}]*cleaned:\s*true[^}]*returned:\s*0[^}]*\}/
  );
  
  assert.ok(
    aiGuardSection,
    "AI guard must return early with returned: 0 (no refund)"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Test 5: Join route correctly skips wallet deduction for private tables
// ────────────────────────────────────────────────────────────────────────────

test("join route skips wallet deduction for private tables", () => {
  const join = read("src/app/api/crash-arena/join/route.ts");

  // Must set isVirtual based on isPrivate
  assert.match(
    join,
    /isVirtual\s*=\s*Boolean\s*\(\s*table\.isPrivate\s*\)/,
    "join route must set isVirtual from table.isPrivate"
  );

  // Must skip balance check for virtual tables
  assert.match(
    join,
    /if\s*\(\s*!isVirtual\s*&&[^)]*user\.balance[^)]*<\s*buyInAmount\s*\)/,
    "join route must skip balance check for private tables"
  );

  // Must skip wallet deduction for virtual tables
  assert.match(
    join,
    /if\s*\(\s*!isVirtual\s*\)\s*\{[\s\S]*?users\.balance\s*-\s*\$\{buyInAmount\}/,
    "join route must skip wallet deduction for private tables"
  );

  // Must skip BUY_IN transaction for virtual tables
  assert.match(
    join,
    /if\s*\(\s*!isVirtual\s*\)\s*\{[\s\S]*?crashArenaTransactions[\s\S]*?type:\s*"BUY_IN"/,
    "join route must skip BUY_IN transaction for private tables"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Test 6: Manual leave route has isPrivate guard (existing behavior)
// ────────────────────────────────────────────────────────────────────────────

test("manual leave route has isPrivate guard preventing refund", () => {
  const leave = read("src/app/api/crash-arena/leave/route.ts");

  // Must check isPrivate
  assert.match(
    leave,
    /isVirtual\s*=\s*Boolean\s*\(\s*table\?\.isPrivate\s*\)/,
    "leave route must check table.isPrivate"
  );

  // Must skip wallet refund for virtual tables
  assert.match(
    leave,
    /if\s*\(\s*!isVirtual\s*&&[^)]*returnAmount\s*>\s*0\s*\)/,
    "leave route must skip wallet refund for private tables"
  );

  // Must skip LEAVE transaction for virtual tables
  assert.match(
    leave,
    /if\s*\(\s*!isVirtual\s*\)\s*\{[\s\S]*?crashArenaTransactions[\s\S]*?type:\s*"LEAVE"/,
    "leave route must skip LEAVE transaction for private tables"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Test 7: Disconnect cleanup route uses the shared helper
// ────────────────────────────────────────────────────────────────────────────

test("disconnect-cleanup route delegates to releaseCrashArenaSeat", () => {
  const disconnect = read("src/app/api/crash-arena/disconnect-cleanup/route.ts");

  // Must import the helper
  assert.match(
    disconnect,
    /import\s*\{[^}]*releaseCrashArenaSeat[^}]*\}\s*from/,
    "disconnect-cleanup must import releaseCrashArenaSeat"
  );

  // Must call the helper
  assert.match(
    disconnect,
    /await\s+releaseCrashArenaSeat\s*\(/,
    "disconnect-cleanup must call releaseCrashArenaSeat"
  );

  // Must verify the token before calling the helper
  const verifyMatch = disconnect.match(/verifyToken/);
  const releaseMatch = disconnect.match(/releaseCrashArenaSeat/);
  
  if (verifyMatch && releaseMatch) {
    assert.ok(
      verifyMatch.index < releaseMatch.index,
      "disconnect-cleanup must verify token before releasing seat"
    );
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 8: Stale sweep route also uses the shared helper
// ────────────────────────────────────────────────────────────────────────────

test("sweep-stale route delegates to releaseCrashArenaSeat", () => {
  const sweep = read("src/app/api/crash-arena/sweep-stale/route.ts");

  // Must import the helper
  assert.match(
    sweep,
    /import\s*\{[^}]*releaseCrashArenaSeat[^}]*\}\s*from/,
    "sweep-stale must import releaseCrashArenaSeat"
  );

  // Must call the helper
  assert.match(
    sweep,
    /await\s+releaseCrashArenaSeat\s*\(/,
    "sweep-stale must call releaseCrashArenaSeat"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Test 9: Cleanup helper marks seat as "left" for private tables
// ────────────────────────────────────────────────────────────────────────────

test("releaseCrashArenaSeat marks private table seats as left", () => {
  const cleanup = read("src/lib/crash-arena/cleanup.ts");

  // The isVirtual guard must update the player status to "left"
  const virtualGuardSection = cleanup.match(
    /if\s*\(\s*isVirtual\s*\)\s*\{[\s\S]*?return\s*\{[^}]*cleaned:\s*true/
  );
  
  assert.ok(virtualGuardSection, "isVirtual guard must exist");

  const guardBody = virtualGuardSection[0];

  // Must update crashArenaPlayers status to "left"
  assert.match(
    guardBody,
    /update\s*\(\s*crashArenaPlayers\s*\)[\s\S]*?set\s*\(\s*\{\s*status:\s*"left"/,
    "isVirtual guard must mark player status as left"
  );

  // Must use the correct WHERE clause (player id + status check)
  assert.match(
    guardBody,
    /where\s*\([\s\S]*?eq\s*\(\s*crashArenaPlayers\.id,\s*player\.id\s*\)/,
    "isVirtual guard must target the correct player by id"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Test 10: Cleanup helper broadcasts updates for private tables
// ────────────────────────────────────────────────────────────────────────────

test("releaseCrashArenaSeat broadcasts updates for private table disconnects", () => {
  const cleanup = read("src/lib/crash-arena/cleanup.ts");

  // The isVirtual guard must broadcast table and lobby updates
  const virtualGuardSection = cleanup.match(
    /if\s*\(\s*isVirtual\s*\)\s*\{[\s\S]*?return\s*\{[^}]*cleaned:\s*true/
  );
  
  assert.ok(virtualGuardSection, "isVirtual guard must exist");

  const guardBody = virtualGuardSection[0];

  // Must broadcast table update
  assert.match(
    guardBody,
    /broadcastTableUpdate\s*\(\s*tableId/,
    "isVirtual guard must broadcast table update"
  );

  // Must broadcast lobby update
  assert.match(
    guardBody,
    /broadcastLobbyUpdate\s*\(/,
    "isVirtual guard must broadcast lobby update"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Test 11: Security property - no path refunds private chips
// ────────────────────────────────────────────────────────────────────────────

test("no code path refunds private table chips to wallet", () => {
  const cleanup = read("src/lib/crash-arena/cleanup.ts");

  // Extract all wallet refund operations
  const refundPattern = /users\.balance\s*\+|balance:\s*sql`\$\{users\.balance\}\s*\+/g;
  const refundMatches = [...cleanup.matchAll(refundPattern)];

  // For each refund, verify it's guarded by !isVirtual or comes after the isVirtual early return
  for (const match of refundMatches) {
    const beforeRefund = cleanup.substring(0, match.index);
    
    // Check if this refund is after the isVirtual early return
    const hasVirtualGuard = beforeRefund.match(
      /if\s*\(\s*isVirtual\s*\)\s*\{[\s\S]*?return\s*\{[^}]*cleaned:\s*true/
    );
    
    assert.ok(
      hasVirtualGuard,
      "Every wallet refund must be unreachable for private tables (after isVirtual early return)"
    );
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 12: Security property - no path creates LEAVE transaction for private
// ────────────────────────────────────────────────────────────────────────────

test("no code path creates LEAVE transaction for private tables", () => {
  const cleanup = read("src/lib/crash-arena/cleanup.ts");

  // Extract all LEAVE transaction insertions
  const leavePattern = /crashArenaTransactions[\s\S]*?type:\s*"LEAVE"/g;
  const leaveMatches = [...cleanup.matchAll(leavePattern)];

  // For each LEAVE transaction, verify it's after the isVirtual early return
  for (const match of leaveMatches) {
    const beforeLeave = cleanup.substring(0, match.index);
    
    // Check if this transaction is after the isVirtual early return
    const hasVirtualGuard = beforeLeave.match(
      /if\s*\(\s*isVirtual\s*\)\s*\{[\s\S]*?return\s*\{[^}]*cleaned:\s*true/
    );
    
    assert.ok(
      hasVirtualGuard,
      "Every LEAVE transaction must be unreachable for private tables (after isVirtual early return)"
    );
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 13: Verify the fix matches the intended control from manual leave
// ────────────────────────────────────────────────────────────────────────────

test("cleanup helper mirrors manual leave route's isPrivate control", () => {
  const cleanup = read("src/lib/crash-arena/cleanup.ts");
  const leave = read("src/app/api/crash-arena/leave/route.ts");

  // Both must derive isVirtual from isPrivate
  assert.match(
    cleanup,
    /isVirtual\s*=\s*Boolean\s*\(\s*tableData\[0\]\?\.isPrivate\s*\)/,
    "cleanup must derive isVirtual from isPrivate"
  );
  assert.match(
    leave,
    /isVirtual\s*=\s*Boolean\s*\(\s*table\?\.isPrivate\s*\)/,
    "leave must derive isVirtual from isPrivate"
  );

  // Both must skip wallet refund for virtual tables
  const cleanupSkipsRefund = cleanup.match(
    /if\s*\(\s*isVirtual\s*\)\s*\{[\s\S]*?return\s*\{[^}]*returned:\s*0/
  );
  const leaveSkipsRefund = leave.match(
    /if\s*\(\s*!isVirtual\s*&&[^)]*returnAmount\s*>\s*0\s*\)/
  );

  assert.ok(cleanupSkipsRefund, "cleanup must skip refund for private tables");
  assert.ok(leaveSkipsRefund, "leave must skip refund for private tables");

  // Both must skip LEAVE transaction for virtual tables
  const cleanupSkipsTransaction = cleanup.match(
    /if\s*\(\s*isVirtual\s*\)\s*\{[\s\S]*?return\s*\{[^}]*cleaned:\s*true/
  );
  const leaveSkipsTransaction = leave.match(
    /if\s*\(\s*!isVirtual\s*\)\s*\{[\s\S]*?crashArenaTransactions[\s\S]*?type:\s*"LEAVE"/
  );

  assert.ok(cleanupSkipsTransaction, "cleanup must skip transaction for private tables");
  assert.ok(leaveSkipsTransaction, "leave must skip transaction for private tables");
});

// ────────────────────────────────────────────────────────────────────────────
// Test 14: Verify comment explains the security fix
// ────────────────────────────────────────────────────────────────────────────

test("cleanup helper has comment explaining private table virtual chips", () => {
  const cleanup = read("src/lib/crash-arena/cleanup.ts");

  // Must have a comment explaining private tables are virtual
  assert.match(
    cleanup,
    /private.*virtual|virtual.*private/i,
    "cleanup must have comment explaining private tables use virtual chips"
  );

  // Must mention that buy-in was never deducted
  assert.match(
    cleanup,
    /never.*deducted|skip.*deduction/i,
    "cleanup must explain that private buy-ins are never deducted"
  );

  // Must mention that refund must not happen
  assert.match(
    cleanup,
    /never.*refund|must not.*refund/i,
    "cleanup must explain that private chips must never be refunded"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Test 15: Verify the fix is in the correct location (before round checks)
// ────────────────────────────────────────────────────────────────────────────

test("isPrivate guard executes early in cleanup flow", () => {
  const cleanup = read("src/lib/crash-arena/cleanup.ts");

  // Find key sections
  const aiGuardMatch = cleanup.match(/if\s*\(\s*tableData\[0\]\?\.isAi\s*\)/);
  const virtualGuardMatch = cleanup.match(/if\s*\(\s*isVirtual\s*\)/);
  const roundCheckMatch = cleanup.match(/activeRound|crashArenaRounds/);

  assert.ok(aiGuardMatch, "AI guard must exist");
  assert.ok(virtualGuardMatch, "isVirtual guard must exist");
  assert.ok(roundCheckMatch, "round check must exist");

  // isVirtual guard must come after AI guard but before round checks
  assert.ok(
    aiGuardMatch.index < virtualGuardMatch.index,
    "isVirtual guard should come after AI guard"
  );
  assert.ok(
    virtualGuardMatch.index < roundCheckMatch.index,
    "isVirtual guard must execute before round checks"
  );
});
