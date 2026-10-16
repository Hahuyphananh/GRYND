// tests/admin-mfa-stepup.test.mjs
//
// Security tests for the admin MFA step-up gate. These tests verify that the
// pentest finding "Admin API endpoints bypass the required MFA step-up gate"
// has been mitigated.
//
// The vulnerability was: `/api/admin/*` matched the broad `/api/(.*)` public
// route pattern, causing the middleware to return early before the admin MFA
// check. The fix ensures `/api/admin/*` is never treated as a public route.
//
// These tests assert:
//   1. The public route matcher excludes `/api/admin/*` paths
//   2. Admin API routes require authentication
//   3. Admin API routes require admin role verification
//   4. Admin API routes enforce MFA step-up (the core security property)
//   5. The middleware flow reaches the admin MFA gate for `/api/admin/*`

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

// ── Middleware Flow Tests ──────────────────────────────────────────────────

test("public route matcher includes the broad /api/(.*) pattern", () => {
  const proxy = read("src/proxy.ts");
  // The broad pattern is still present (needed for other public APIs)
  assert.match(
    proxy,
    /isPublicRoute\s*=\s*createRouteMatcher\(\[[\s\S]*?["']\/api\/\(\.\*\)["']/,
    "public route matcher should include /api/(.*) pattern"
  );
});

test("admin API routes are explicitly excluded from public route treatment", () => {
  const proxy = read("src/proxy.ts");
  // The fix: admin API routes must never be treated as public. The current
  // implementation guarantees this STRUCTURALLY rather than by negating the
  // public-route condition: /api/admin has its own block that runs before the
  // public-route branch and returns from inside it, so an admin API request can
  // never reach the public early return at all.
  const ADMIN_BLOCK = 'if (pathname.startsWith("/api/admin")) {';
  const PUBLIC_BRANCH = "if (isPublicRoute(req)";

  const adminApiPos = proxy.indexOf(ADMIN_BLOCK);
  assert.ok(adminApiPos > 0, "admin API handler block should exist");

  const publicRoutePos = proxy.indexOf(PUBLIC_BRANCH);
  assert.ok(publicRoutePos > 0, "public route branch should exist");

  assert.ok(
    adminApiPos < publicRoutePos,
    "middleware should handle /api/admin before the public route early return"
  );

  // Fail closed: the admin API block must terminate the request itself, so no
  // code below it (including the public early return) can run for /api/admin.
  const adminBlock = proxy.slice(adminApiPos, publicRoutePos);
  assert.ok(
    adminBlock.includes("return applySecurityHeaders(NextResponse.next());"),
    "admin API block should return after auth + admin role + MFA checks"
  );
});

test("middleware comment documents the admin API exclusion rationale", () => {
  const proxy = read("src/proxy.ts");
  // Defense in depth: the comment explains WHY this check exists
  assert.match(
    proxy,
    /Admin API routes must NEVER be treated as public/i,
    "middleware should document why /api/admin is excluded from public routes"
  );
  assert.match(
    proxy,
    /authentication.*admin role.*MFA step-up/i,
    "comment should mention all three required checks"
  );
  assert.match(
    proxy,
    /bypassing the MFA gate/i,
    "comment should reference the bypass vulnerability"
  );
});

test("admin API routes skip the age gate but not authentication", () => {
  const proxy = read("src/proxy.ts");
  // Admin routes skip age verification (admins can be any age) but still
  // require authentication and MFA
  assert.match(
    proxy,
    /skipsAgeGate[\s\S]*?pathname\.startsWith\(["']\/api\/admin["']\)/,
    "admin API routes should skip age gate"
  );
});

test("admin role check covers both /admin and /api/admin paths", () => {
  const proxy = read("src/proxy.ts");
  // Both UI and API routes require admin role
  assert.match(
    proxy,
    /if\s*\(\s*pathname\.startsWith\(["']\/admin["']\)\s*\|\|\s*pathname\.startsWith\(["']\/api\/admin["']\)\s*\)/,
    "admin role check should cover both /admin and /api/admin"
  );
});

test("admin role check returns 403 JSON for API routes", () => {
  const proxy = read("src/proxy.ts");
  // API routes get JSON responses, not redirects
  assert.match(
    proxy,
    /if\s*\(\s*pathname\.startsWith\(["']\/api\/admin["']\)\s*\)[\s\S]{0,200}NextResponse\.json[\s\S]{0,100}403/,
    "non-admin API access should return 403 JSON"
  );
  assert.match(
    proxy,
    /Admin access required/,
    "403 response should indicate admin access is required"
  );
});

test("admin MFA gate covers both /admin and /api/admin paths", () => {
  const proxy = read("src/proxy.ts");
  // /api/admin and the /admin UI are now gated by separate blocks, so assert
  // each one performs an MFA step-up rather than one combined condition.
  const adminApiPos = proxy.indexOf('if (pathname.startsWith("/api/admin")) {');
  assert.ok(adminApiPos > 0, "admin API handler block should exist");
  const publicRoutePos = proxy.indexOf("if (isPublicRoute(req)");
  const adminApiBlock = proxy.slice(adminApiPos, publicRoutePos);

  const recent = adminApiBlock.indexOf("hasRecentMfa(factorVerificationAge)");
  const adminTok = adminApiBlock.indexOf("verifyAdminMfaToken(adminMfaToken");
  const userTok = adminApiBlock.indexOf("verifyUserMfaToken(userMfaToken");

  assert.ok(recent > -1, "admin API block should accept a recent factor verification");
  assert.ok(adminTok > -1, "admin API block should accept a valid admin MFA cookie");
  assert.ok(userTok > -1, "admin API block should accept a valid user MFA cookie");
  assert.ok(
    recent < adminTok && adminTok < userTok,
    "admin API MFA step-up should test session, then admin cookie, then user cookie"
  );

  // The /admin UI gate (defense in depth) enforces the same step-up.
  const adminUiPos = proxy.indexOf('pathname.startsWith("/admin") && pathname !==');
  assert.ok(adminUiPos > 0, "/admin UI MFA gate should exist");
  assert.ok(
    proxy.slice(adminUiPos, adminUiPos + 900).includes("hasRecentMfa(factorVerificationAge)"),
    "/admin UI gate should enforce MFA step-up"
  );
});

test("admin MFA gate returns 403 JSON for API routes without MFA", () => {
  const proxy = read("src/proxy.ts");
  // API routes without MFA get 403 JSON, never a redirect. The admin API block
  // is far longer than the old 300-char window, so scope the search to the
  // block itself (from its start to the public-route branch).
  const adminApiPos = proxy.indexOf('if (pathname.startsWith("/api/admin")) {');
  assert.ok(adminApiPos > 0, "admin API handler block should exist");
  const publicRoutePos = proxy.indexOf("if (isPublicRoute(req)");
  const adminApiBlock = proxy.slice(adminApiPos, publicRoutePos);

  assert.ok(adminApiBlock.includes("MFA required"), "should return an MFA-required error");
  assert.ok(adminApiBlock.includes("status: 403"), "MFA-required response should be 403");
  assert.ok(
    !adminApiBlock.includes("NextResponse.redirect"),
    "API routes should get JSON, never a redirect"
  );
});

test("admin MFA gate checks Clerk factor verification age", () => {
  const proxy = read("src/proxy.ts");
  // Recent Clerk MFA satisfies the gate
  assert.match(
    proxy,
    /hasRecentMfa\(factorVerificationAge\)/,
    "MFA gate should check Clerk factor verification age"
  );
});

test("admin MFA gate checks admin MFA token cookie", () => {
  const proxy = read("src/proxy.ts");
  // The admin_mfa cookie (24h signed token) satisfies the gate
  assert.match(
    proxy,
    /verifyAdminMfaToken\(adminMfaToken/,
    "MFA gate should verify admin MFA token"
  );
});

test("admin MFA gate checks user MFA token cookie", () => {
  const proxy = read("src/proxy.ts");
  // The user_mfa cookie (defense in depth for dual-MFA admins) satisfies the gate
  assert.match(
    proxy,
    /verifyUserMfaToken\(userMfaToken/,
    "MFA gate should verify user MFA token"
  );
});

test("userMfaGate explicitly skips all /api/ paths", () => {
  const proxy = read("src/proxy.ts");
  // The user-level MFA gate skips API routes (they're not interactive pages)
  assert.match(
    proxy,
    /pathname\.startsWith\(["']\/api\/["']\)/,
    "userMfaGate should skip /api/ paths"
  );
});

test("admin MFA gate runs BEFORE the public route early return", () => {
  const proxy = read("src/proxy.ts");
  // Superseded design: this gate used to sit AFTER the public-route branch and
  // depend on that branch negating /api/admin. It now runs BEFORE the branch
  // entirely, which is strictly safer — the public early return (and the
  // userMfaGate call inside it, which skips every /api/ path) is unreachable
  // for an /api/admin request. This assertion fails if the gate is ever moved
  // back below the branch.
  const adminApiPos = proxy.indexOf('if (pathname.startsWith("/api/admin")) {');
  assert.ok(adminApiPos > 0, "should find the admin API handler block");

  const publicRoutePos = proxy.indexOf("if (isPublicRoute(req)");
  assert.ok(publicRoutePos > 0, "should find public route check");

  const adminBlock = proxy.slice(adminApiPos, publicRoutePos);
  assert.ok(adminBlock.includes("adminMfaToken"), "the admin MFA gate should sit in that block");

  assert.ok(
    adminApiPos < publicRoutePos,
    "admin MFA gate should come BEFORE the public route check so it cannot be bypassed"
  );
});

// ── Admin API Endpoint Tests ───────────────────────────────────────────────

test("ban-user endpoint requires authentication", () => {
  const route = read("src/app/api/admin/ban-user/route.ts");
  assert.match(
    route,
    /await\s+auth\(\)/,
    "ban-user should call auth()"
  );
  assert.match(
    route,
    /if\s*\(\s*!userId\s*\)/,
    "ban-user should check userId"
  );
  assert.match(
    route,
    /Unauthorized/,
    "ban-user should return Unauthorized for missing auth"
  );
  assert.match(
    route,
    /401/,
    "ban-user should return 401 status"
  );
});

test("ban-user endpoint requires admin role", () => {
  const route = read("src/app/api/admin/ban-user/route.ts");
  assert.match(
    route,
    /isAdmin\(userId\)/,
    "ban-user should call isAdmin()"
  );
  assert.match(
    route,
    /Forbidden/,
    "ban-user should return Forbidden for non-admins"
  );
  assert.match(
    route,
    /403/,
    "ban-user should return 403 status"
  );
});

test("ban-user endpoint does not independently check MFA (relies on middleware)", () => {
  const route = read("src/app/api/admin/ban-user/route.ts");
  // The endpoint relies on the middleware MFA gate (defense in depth)
  assert.doesNotMatch(
    route,
    /factorVerificationAge|hasRecentMfa|adminMfaToken|verifyAdminMfaToken/,
    "ban-user should rely on middleware for MFA enforcement"
  );
});

test("users admin-toggle endpoint requires authentication", () => {
  const route = read("src/app/api/admin/users/[clerkId]/admin/route.ts");
  assert.match(
    route,
    /await\s+auth\(\)/,
    "admin-toggle should call auth()"
  );
  assert.match(
    route,
    /if\s*\(\s*!userId\s*\)/,
    "admin-toggle should check userId"
  );
  assert.match(
    route,
    /Unauthorized/,
    "admin-toggle should return Unauthorized for missing auth"
  );
});

test("users admin-toggle endpoint requires admin role", () => {
  const route = read("src/app/api/admin/users/[clerkId]/admin/route.ts");
  assert.match(
    route,
    /isAdmin\(userId\)/,
    "admin-toggle should call isAdmin()"
  );
  assert.match(
    route,
    /Forbidden/,
    "admin-toggle should return Forbidden for non-admins"
  );
});

test("reset-tokens endpoint requires authentication", () => {
  const route = read("src/app/api/admin/reset-tokens/route.ts");
  assert.match(
    route,
    /await\s+auth\(\)/,
    "reset-tokens should call auth()"
  );
  assert.match(
    route,
    /if\s*\(\s*!adminId\s*\)/,
    "reset-tokens should check adminId"
  );
  assert.match(
    route,
    /Unauthorized/,
    "reset-tokens should return Unauthorized for missing auth"
  );
});

test("reset-tokens endpoint requires admin role", () => {
  const route = read("src/app/api/admin/reset-tokens/route.ts");
  assert.match(
    route,
    /isAdmin\(adminId\)/,
    "reset-tokens should call isAdmin()"
  );
  assert.match(
    route,
    /Forbidden/,
    "reset-tokens should return Forbidden for non-admins"
  );
});

// ── Admin Page Tests ───────────────────────────────────────────────────────

test("admin page independently enforces MFA step-up (defense in depth)", () => {
  const page = read("src/app/admin/page.tsx");
  // The page re-checks MFA even though middleware already enforced it
  assert.match(
    page,
    /hasRecentMfa\(factorVerificationAge\)/,
    "admin page should check Clerk factor verification age"
  );
  assert.match(
    page,
    /verifyAdminMfaToken/,
    "admin page should verify admin MFA token"
  );
  assert.match(
    page,
    /redirect.*mfa-required/i,
    "admin page should redirect to MFA gate when not satisfied"
  );
});

test("admin page comment confirms MFA is a required trust boundary", () => {
  const page = read("src/app/admin/page.tsx");
  // The comment confirms this is intentional defense in depth
  assert.match(
    page,
    /Admin access requires.*second factor/i,
    "admin page should document MFA requirement"
  );
  assert.match(
    page,
    /defense in depth/i,
    "admin page should note this is defense in depth"
  );
});

// ── MFA Setup Endpoint Tests ───────────────────────────────────────────────

test("TOTP setup endpoint requires authentication", () => {
  const route = read("src/app/api/admin/mfa/setup-totp/route.ts");
  assert.match(
    route,
    /await\s+auth\(\)/,
    "setup-totp should call auth()"
  );
  assert.match(
    route,
    /if\s*\(\s*!userId\s*\)/,
    "setup-totp should check userId"
  );
  assert.match(
    route,
    /Unauthorized/,
    "setup-totp should return Unauthorized for missing auth"
  );
});

test("TOTP setup endpoint requires admin role", () => {
  const route = read("src/app/api/admin/mfa/setup-totp/route.ts");
  assert.match(
    route,
    /isAdmin\(userId\)/,
    "setup-totp should call isAdmin()"
  );
  assert.match(
    route,
    /Forbidden/,
    "setup-totp should return Forbidden for non-admins"
  );
});

test("MFA status endpoint requires authentication", () => {
  const route = read("src/app/api/admin/mfa/status/route.ts");
  assert.match(
    route,
    /await\s+auth\(\)/,
    "mfa/status should call auth()"
  );
  assert.match(
    route,
    /if\s*\(\s*!userId\s*\)/,
    "mfa/status should check userId"
  );
  assert.match(
    route,
    /Unauthorized/,
    "mfa/status should return Unauthorized for missing auth"
  );
});

test("MFA status endpoint requires admin role", () => {
  const route = read("src/app/api/admin/mfa/status/route.ts");
  assert.match(
    route,
    /isAdmin\(userId\)/,
    "mfa/status should call isAdmin()"
  );
  assert.match(
    route,
    /Forbidden/,
    "mfa/status should return Forbidden for non-admins"
  );
});

// ── Integration Tests ──────────────────────────────────────────────────────

test("middleware enforces all three gates in order: auth, admin role, MFA", () => {
  const proxy = read("src/proxy.ts");

  // On the /api/admin path all three checks live inside one block, and their
  // ORDER is the security property: identity, then authorization, then MFA.
  const adminApiPos = proxy.indexOf('if (pathname.startsWith("/api/admin")) {');
  assert.ok(adminApiPos > 0, "admin API handler block should exist");
  const publicRoutePos = proxy.indexOf("if (isPublicRoute(req)");
  const adminBlock = proxy.slice(adminApiPos, publicRoutePos);

  const authGate = adminBlock.indexOf("if (!userId)");
  const adminRoleGate = adminBlock.indexOf("isAdmin(userId)");
  const adminMfaGate = adminBlock.indexOf("hasRecentMfa(factorVerificationAge)");

  assert.ok(authGate > -1, "should find the authentication gate");
  assert.ok(adminRoleGate > -1, "should find the admin role gate");
  assert.ok(adminMfaGate > -1, "should find the admin MFA gate");

  assert.ok(
    authGate < adminRoleGate,
    "authentication should come before the admin role check"
  );
  assert.ok(
    adminRoleGate < adminMfaGate,
    "admin role check should come before the MFA gate"
  );
});

test("no admin API endpoint bypasses the middleware MFA gate", () => {
  const proxy = read("src/proxy.ts");

  // The fix ensures /api/admin/* is handled by its own block, positioned before
  // the public route early return, so no admin API path can slip through as
  // "public" and short-circuit the MFA gate.
  const adminApiPos = proxy.indexOf('if (pathname.startsWith("/api/admin")) {');
  assert.ok(adminApiPos > 0, "admin API handler block should exist");
  const publicRoutePos = proxy.indexOf("if (isPublicRoute(req)");
  assert.ok(
    adminApiPos < publicRoutePos,
    "middleware should handle /api/admin before any public route treatment"
  );

  // Verify the early return is still present (for other public routes)
  assert.ok(
    proxy.includes("return applySecurityHeaders(NextResponse.next());"),
    "middleware should still have an early return for public routes"
  );
});

test("admin API routes are documented as requiring MFA step-up", () => {
  const proxy = read("src/proxy.ts");

  // The comment above the admin API block must explain WHY the block is ordered
  // before the public route branch, so a later refactor cannot "tidy" the
  // ordering away without the rationale being visible.
  const adminApiPos = proxy.indexOf('if (pathname.startsWith("/api/admin")) {');
  assert.ok(adminApiPos > 0, "admin API handler block should exist");
  const comment = proxy.slice(Math.max(0, adminApiPos - 400), adminApiPos);

  assert.match(
    comment,
    /BEFORE the public-route branch/i,
    "comment should document the required ordering"
  );
  assert.match(
    comment,
    /authentication.*admin role.*MFA step-up/i,
    "comment should list all three required checks"
  );
  assert.match(
    comment,
    /bypassing the MFA gate/i,
    "comment should reference the bypass the ordering prevents"
  );
});

test("all destructive admin endpoints are protected by the middleware gate", () => {
  // These are the endpoints mentioned in the pentest finding
  const endpoints = [
    "src/app/api/admin/ban-user/route.ts",
    "src/app/api/admin/users/[clerkId]/admin/route.ts",
    "src/app/api/admin/reset-tokens/route.ts",
  ];
  
  for (const endpoint of endpoints) {
    const route = read(endpoint);
    
    // Each endpoint checks auth and admin role
    assert.match(
      route,
      /await\s+auth\(\)/,
      `${endpoint} should call auth()`
    );
    assert.match(
      route,
      /isAdmin/,
      `${endpoint} should call isAdmin()`
    );
    
    // None of them independently check MFA (they rely on middleware)
    assert.doesNotMatch(
      route,
      /factorVerificationAge|hasRecentMfa|adminMfaToken|verifyAdminMfaToken/,
      `${endpoint} should rely on middleware for MFA enforcement`
    );
  }
});
