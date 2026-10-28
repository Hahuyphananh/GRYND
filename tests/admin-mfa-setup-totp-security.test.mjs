// tests/admin-mfa-setup-totp-security.test.mjs
// Security test: verify that /api/admin/mfa/setup-totp requires completed MFA
// before exposing the global TOTP secret.
//
// Pentest finding: First-factor-only admins could retrieve the global TOTP seed
// and mint an admin MFA cookie, bypassing the second-factor boundary.
//
// Mitigation: The proxy middleware now enforces MFA completion before allowing
// access to /api/admin/mfa/setup-totp, preventing the disclosure of the secret
// to admins who have only completed their first factor.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

/**
 * Extract a brace-balanced block from proxy.ts, starting at `header`.
 *
 * These tests used to slice the source with `([\s\S]{0,1000})` windows. That
 * silently captured the WRONG code as soon as an unrelated branch moved (a
 * `pathname.startsWith("/api/admin")` window landed inside the maintenance
 * block), so a guard that was present still failed its own test. Walking the
 * braces keeps each assertion on the block it names.
 */
function blockFrom(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `proxy.ts no longer contains: ${header}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced block after: ${header}`);
}

/** The branch that makes public routes (every /api/* path included) reachable. */
function publicRouteBranch() {
  return blockFrom(read("src/proxy.ts"), "if (isPublicRoute(req)");
}

test("proxy middleware enforces MFA for /api/admin/mfa/setup-totp", () => {
  const proxy = read("src/proxy.ts");

  // The proxy must check the specific setup-totp path
  assert.match(
    proxy,
    /pathname\s*===\s*["']\/api\/admin\/mfa\/setup-totp["']/,
    "proxy should explicitly check for /api/admin/mfa/setup-totp path"
  );

  // The proxy must verify authentication
  assert.match(
    proxy,
    /userId.*await\s+auth\(\)/s,
    "proxy should extract userId from auth() for setup-totp check"
  );

  // The proxy must verify admin role
  assert.match(
    proxy,
    /isAdmin\(userId\)/,
    "proxy should verify admin role for setup-totp"
  );

  // The proxy must check for MFA completion via multiple methods
  assert.match(
    proxy,
    /hasRecentMfa\(factorVerificationAge\)/,
    "proxy should check for recent native MFA (Clerk)"
  );

  assert.match(
    proxy,
    /verifyAdminMfaToken\(adminMfaToken,\s*userId\)/,
    "proxy should verify admin MFA token cookie"
  );

  assert.match(
    proxy,
    /verifyUserMfaToken\(userMfaToken,\s*userId\)/,
    "proxy should verify user MFA token cookie"
  );

  // The proxy must reject requests without MFA
  assert.match(
    proxy,
    /MFA required/i,
    "proxy should return an MFA required error message"
  );

  // The proxy must return 403 Forbidden when MFA is not satisfied
  assert.match(
    proxy,
    /status:\s*403/,
    "proxy should return 403 status when MFA is missing"
  );

  // The proxy must audit the MFA requirement
  assert.match(
    proxy,
    /auditLog\(["']admin_mfa_required["']/,
    "proxy should audit when admin MFA is required"
  );
});

test("proxy middleware checks MFA before allowing setup-totp in public route branch", () => {
  // The branch is declared as `isPublicRoute(req) && !isGameRoute(pathname)`:
  // public game routes fall through to the auth block instead.
  const branch = publicRouteBranch();

  // The setup-totp MFA check must be within the public route branch
  assert.match(
    branch,
    /pathname\s*===\s*["']\/api\/admin\/mfa\/setup-totp["']/,
    "setup-totp MFA check should be in the public route branch"
  );

  assert.match(
    branch,
    /hasRecentMfa/,
    "public route branch should check hasRecentMfa for setup-totp"
  );

  assert.match(
    branch,
    /verifyAdminMfaToken/,
    "public route branch should verify admin MFA token for setup-totp"
  );

  // …and it must run before the branch hands the request on.
  const setupTotpIndex = branch.indexOf('pathname === "/api/admin/mfa/setup-totp"');
  const fallThrough = branch.search(/return applySecurityHeaders\(\s*NextResponse\.next\(\)\s*\)/);
  assert.ok(setupTotpIndex > -1, "setup-totp guard should be in the branch");
  assert.ok(
    fallThrough > setupTotpIndex,
    "the branch must not return NextResponse.next() before the setup-totp guard"
  );
});

test("setup-totp route handler still has basic auth and admin checks", () => {
  const route = read("src/app/api/admin/mfa/setup-totp/route.ts");

  // Defense in depth: the route handler should still have its own checks
  assert.match(
    route,
    /await\s+auth\(\)/,
    "setup-totp route should call auth()"
  );

  assert.match(
    route,
    /if\s*\(\s*!userId\s*\)/,
    "setup-totp route should check for missing userId"
  );

  assert.match(
    route,
    /Unauthorized/,
    "setup-totp route should return Unauthorized for missing auth"
  );

  assert.match(
    route,
    /isAdmin\(userId\)/,
    "setup-totp route should verify admin role"
  );

  assert.match(
    route,
    /Forbidden/,
    "setup-totp route should return Forbidden for non-admins"
  );

  // The route returns the sensitive TOTP secret
  assert.match(
    route,
    /ADMIN_TOTP_SECRET/,
    "setup-totp route should access ADMIN_TOTP_SECRET"
  );

  assert.match(
    route,
    /success:\s*true,[\s\S]*secret/,
    "setup-totp route should return the secret in the response"
  );
});

test("verify route does not independently require MFA (allows initial enrollment)", () => {
  const route = read("src/app/api/admin/mfa/verify/route.ts");

  // The verify route should NOT require MFA (it's used to establish MFA)
  // It should only require auth and admin role
  assert.match(
    route,
    /await\s+auth\(\)/,
    "verify route should call auth()"
  );

  assert.match(
    route,
    /isAdmin\(userId\)/,
    "verify route should verify admin role"
  );

  // The verify route should issue the admin MFA cookie
  assert.match(
    route,
    /ADMIN_MFA_COOKIE/,
    "verify route should reference ADMIN_MFA_COOKIE"
  );

  assert.match(
    route,
    /issueAdminMfaToken\(userId\)/,
    "verify route should issue admin MFA token"
  );

  assert.match(
    route,
    /res\.cookies\.set\(ADMIN_MFA_COOKIE/,
    "verify route should set the admin MFA cookie"
  );
});

test("proxy middleware uses correct logical operators for MFA checks", () => {
  const proxy = read("src/proxy.ts");

  // The MFA check should use AND (&&) to require ALL checks to fail before rejecting
  // This means if ANY check passes (recent MFA OR admin token OR user token), access is granted
  const setupTotpSection = proxy.match(
    /pathname\s*===\s*["']\/api\/admin\/mfa\/setup-totp["']([\s\S]*?)(?=\n\s*return applySecurityHeaders\(NextResponse\.next)/
  );

  assert.ok(
    setupTotpSection,
    "should find the setup-totp section in proxy"
  );

  const setupTotpCode = setupTotpSection[1];

  // Check for the correct logical structure: !A && !B && !C
  // This means: reject if (NOT hasRecentMfa) AND (NOT adminToken) AND (NOT userToken)
  assert.match(
    setupTotpCode,
    /!\s*hasRecentMfa[\s\S]*&&[\s\S]*!\s*.*verifyAdminMfaToken[\s\S]*&&[\s\S]*!\s*.*verifyUserMfaToken/,
    "MFA check should use AND (&&) operators to require all checks to fail before rejecting"
  );
});

test("proxy middleware returns proper error response for missing MFA", () => {
  const proxy = read("src/proxy.ts");

  const setupTotpSection = proxy.match(
    /pathname\s*===\s*["']\/api\/admin\/mfa\/setup-totp["']([\s\S]*?)(?=\n\s*return applySecurityHeaders\(NextResponse\.next)/
  );

  assert.ok(setupTotpSection, "should find setup-totp section");
  const setupTotpCode = setupTotpSection[1];

  // Should return JSON error response
  assert.match(
    setupTotpCode,
    /NextResponse\.json/,
    "should return JSON response for MFA failure"
  );

  // Should include success: false
  assert.match(
    setupTotpCode,
    /success:\s*false/,
    "should return success: false for MFA failure"
  );

  // Should include error message
  assert.match(
    setupTotpCode,
    /error:\s*["'].*MFA.*["']/i,
    "should return error message mentioning MFA"
  );

  // Should return 403 status
  assert.match(
    setupTotpCode,
    /status:\s*403/,
    "should return 403 Forbidden status for missing MFA"
  );

  // Should apply security headers
  assert.match(
    setupTotpCode,
    /applySecurityHeaders/,
    "should apply security headers to error response"
  );
});

test("proxy middleware checks admin role before MFA for setup-totp", () => {
  const proxy = read("src/proxy.ts");

  const setupTotpSection = proxy.match(
    /pathname\s*===\s*["']\/api\/admin\/mfa\/setup-totp["']([\s\S]{0,1500})/
  );

  assert.ok(setupTotpSection, "should find setup-totp section");
  const setupTotpCode = setupTotpSection[1];

  // Should check userId first
  assert.match(
    setupTotpCode,
    /if\s*\(\s*!userId\s*\)/,
    "should check for missing userId"
  );

  // Should return 401 for missing auth
  assert.match(
    setupTotpCode,
    /status:\s*401/,
    "should return 401 for missing authentication"
  );

  // Should check admin role
  assert.match(
    setupTotpCode,
    /if\s*\(\s*!\s*.*await\s+isAdmin\(userId\)/,
    "should check admin role"
  );

  // Should return 403 for non-admin
  const forbiddenMatches = setupTotpCode.match(/status:\s*403/g);
  assert.ok(
    forbiddenMatches && forbiddenMatches.length >= 2,
    "should return 403 for both non-admin and missing MFA"
  );
});

test("exploit scenario: admin without MFA cannot access setup-totp", () => {
  const proxy = read("src/proxy.ts");

  // Simulate the exploit scenario from the pentest:
  // 1. Attacker has valid Clerk session (userId exists)
  // 2. Attacker has admin role (isAdmin returns true)
  // 3. Attacker does NOT have MFA completed
  //
  // Expected: Request should be rejected with 403 and MFA required message

  const setupTotpSection = proxy.match(
    /pathname\s*===\s*["']\/api\/admin\/mfa\/setup-totp["']([\s\S]*?)(?=\n\s*return applySecurityHeaders\(NextResponse\.next)/
  );

  assert.ok(setupTotpSection, "should find setup-totp section");
  const setupTotpCode = setupTotpSection[1];

  // The code must check all three MFA verification methods
  assert.match(
    setupTotpCode,
    /hasRecentMfa/,
    "must check Clerk native MFA"
  );

  assert.match(
    setupTotpCode,
    /verifyAdminMfaToken/,
    "must check admin MFA cookie"
  );

  assert.match(
    setupTotpCode,
    /verifyUserMfaToken/,
    "must check user MFA cookie"
  );

  // If all three checks fail (no MFA), must reject
  assert.match(
    setupTotpCode,
    /!\s*hasRecentMfa[\s\S]*&&[\s\S]*!\s*.*verifyAdminMfaToken[\s\S]*&&[\s\S]*!\s*.*verifyUserMfaToken[\s\S]*\{[\s\S]*?return/,
    "must reject request when all MFA checks fail"
  );

  // Must return error response, not allow through
  assert.match(
    setupTotpCode,
    /!\s*hasRecentMfa[\s\S]*&&[\s\S]*!\s*.*verifyAdminMfaToken[\s\S]*&&[\s\S]*!\s*.*verifyUserMfaToken[\s\S]*\{[\s\S]*?NextResponse\.json/,
    "must return JSON error when MFA is missing"
  );
});

test("mitigation completeness: setup-totp is protected in public route branch", () => {
  // The vulnerability existed because /api/* routes are public routes,
  // and the setup-totp endpoint was reached before the admin MFA enforcement
  // that happens later in the middleware for /api/admin/* routes.
  //
  // The fix adds explicit MFA enforcement for setup-totp in the public route branch.
  const branch = publicRouteBranch();

  // The setup-totp check must be AFTER userMfaGate but BEFORE the final return
  const userMfaGateIndex = branch.indexOf("userMfaGate");
  const setupTotpIndex = branch.indexOf("/api/admin/mfa/setup-totp");
  const fallThrough = branch.search(/return applySecurityHeaders\(\s*NextResponse\.next\(\)\s*\)/);

  assert.ok(
    userMfaGateIndex >= 0,
    "public route branch should have userMfaGate"
  );

  assert.ok(
    setupTotpIndex >= 0,
    "public route branch should have setup-totp check"
  );

  assert.ok(
    setupTotpIndex > userMfaGateIndex,
    "setup-totp check should come after userMfaGate"
  );

  assert.ok(
    fallThrough > setupTotpIndex,
    "setup-totp check should come before the branch returns NextResponse.next()"
  );

  // The setup-totp check must return early if MFA is not satisfied
  const setupTotpToEnd = branch.substring(setupTotpIndex);
  assert.match(
    setupTotpToEnd,
    /return\s+applySecurityHeaders\(\s*NextResponse\.json/,
    "setup-totp check should return early with error response if MFA missing"
  );
});

test("defense in depth: admin MFA enforcement still exists for /api/admin routes", () => {
  const proxy = read("src/proxy.ts");

  // The general /api/admin/* enforcement should still exist as defense in depth
  assert.match(
    proxy,
    /pathname\.startsWith\(["']\/api\/admin["']\)/,
    "proxy should have general /api/admin enforcement"
  );

  // Anchor on the branch itself — NOT on the first `startsWith("/api/admin")`
  // in the file, which is the maintenance exemption further up.
  const apiAdminCode = blockFrom(proxy, 'if (pathname.startsWith("/api/admin"))');

  assert.match(
    apiAdminCode,
    /await\s+auth\(\)/,
    "/api/admin section should authenticate the request"
  );

  assert.match(
    apiAdminCode,
    /isAdmin\(userId\)/,
    "/api/admin section should check the admin role"
  );

  assert.match(
    apiAdminCode,
    /ADMIN_MFA_COOKIE/,
    "/api/admin section should check ADMIN_MFA_COOKIE"
  );

  assert.match(
    apiAdminCode,
    /verifyAdminMfaToken/,
    "/api/admin section should verify admin MFA token"
  );

  assert.match(
    apiAdminCode,
    /verifyUserMfaToken/,
    "/api/admin section should accept a user MFA token"
  );

  assert.match(
    apiAdminCode,
    /admin_mfa_required/,
    "/api/admin section should audit the refused step-up"
  );

  assert.match(
    apiAdminCode,
    /MFA required for admin access/,
    "/api/admin section should refuse with the MFA error"
  );
});

test("audit logging: MFA requirement is logged for setup-totp", () => {
  const proxy = read("src/proxy.ts");

  const setupTotpSection = proxy.match(
    /pathname\s*===\s*["']\/api\/admin\/mfa\/setup-totp["']([\s\S]*?)(?=\n\s*return applySecurityHeaders\(NextResponse\.next)/
  );

  assert.ok(setupTotpSection, "should find setup-totp section");
  const setupTotpCode = setupTotpSection[1];

  // Should log when MFA is required
  assert.match(
    setupTotpCode,
    /auditLog\(/,
    "should call auditLog when MFA is required"
  );

  assert.match(
    setupTotpCode,
    /auditLog\(["']admin_mfa_required["']/,
    "should log 'admin_mfa_required' event"
  );

  // Should include relevant context
  assert.match(
    setupTotpCode,
    /userId.*ip.*path/s,
    "audit log should include userId, ip, and path"
  );
});
