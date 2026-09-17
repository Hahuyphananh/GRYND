// tests/security-admin-mfa-stepup.test.mjs
//
// Unit tests verifying that the admin API MFA step-up bypass vulnerability
// (pentest finding: "Admin API endpoints bypass the required MFA step-up gate")
// has been mitigated.
//
// The vulnerability: /api/admin/* matched the broad /api/(.*) public route
// pattern, causing the middleware to return early via userMfaGate (which skips
// all API paths) before reaching the admin MFA check. This allowed admins with
// only first-factor authentication to invoke privileged operations without MFA.
//
// The fix: Admin API routes are now handled BEFORE the public-route branch,
// with explicit authentication, authorization, and MFA step-up checks.
//
// Run: node --import tsx --test tests/security-admin-mfa-stepup.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

test("proxy: admin API routes are handled BEFORE public route branch", () => {
  const proxy = read("src/proxy.ts");
  
  // Find the admin API handler block
  const adminApiMatch = proxy.match(
    /if\s*\(\s*pathname\.startsWith\s*\(\s*["']\/api\/admin["']\s*\)\s*\)\s*\{/
  );
  assert.ok(adminApiMatch, "Admin API handler block should exist");
  const adminApiPos = adminApiMatch.index;
  
  // Find the public route handler block
  const publicRouteMatch = proxy.match(
    /if\s*\(\s*isPublicRoute\s*\(\s*req\s*\)\s*\)\s*\{/
  );
  assert.ok(publicRouteMatch, "Public route handler block should exist");
  const publicRoutePos = publicRouteMatch.index;
  
  // Admin API handler MUST come before public route handler
  assert.ok(
    adminApiPos < publicRoutePos,
    "Admin API handler must be positioned BEFORE public route handler to prevent bypass"
  );
});

test("proxy: admin API handler enforces authentication", () => {
  const proxy = read("src/proxy.ts");
  
  // Extract the admin API handler block
  const adminApiStart = proxy.indexOf('if (pathname.startsWith("/api/admin"))');
  assert.ok(adminApiStart > 0, "Admin API handler should exist");
  
  // Find the closing brace of the admin API block (approximate)
  const adminApiEnd = proxy.indexOf("return applySecurityHeaders(NextResponse.next());", adminApiStart);
  assert.ok(adminApiEnd > adminApiStart, "Admin API handler should have proper structure");
  
  const adminApiBlock = proxy.substring(adminApiStart, adminApiEnd + 100);
  
  // Must call auth() to get userId
  assert.match(
    adminApiBlock,
    /await\s+auth\(\)/,
    "Admin API handler must call auth()"
  );
  
  // Must check for userId presence
  assert.match(
    adminApiBlock,
    /if\s*\(\s*!userId\s*\)/,
    "Admin API handler must check for missing userId"
  );
  
  // Must return 401 Unauthorized when not authenticated
  assert.match(
    adminApiBlock,
    /status:\s*401/,
    "Admin API handler must return 401 for unauthenticated requests"
  );
  
  assert.match(
    adminApiBlock,
    /Unauthorized/,
    "Admin API handler must return 'Unauthorized' error message"
  );
  
  // Must audit log the auth failure
  assert.match(
    adminApiBlock,
    /auditLog\s*\(\s*["']admin_api_auth_required["']/,
    "Admin API handler must audit log authentication failures"
  );
});

test("proxy: admin API handler enforces admin role authorization", () => {
  const proxy = read("src/proxy.ts");
  
  const adminApiStart = proxy.indexOf('if (pathname.startsWith("/api/admin"))');
  const adminApiEnd = proxy.indexOf("return applySecurityHeaders(NextResponse.next());", adminApiStart);
  const adminApiBlock = proxy.substring(adminApiStart, adminApiEnd + 100);
  
  // Must check admin status via isAdmin() or env var allowlist
  assert.match(
    adminApiBlock,
    /isAdmin\s*\(\s*userId\s*\)/,
    "Admin API handler must call isAdmin(userId)"
  );
  
  // Must check CHAT_ADMIN_CLERK_IDS env var
  assert.match(
    adminApiBlock,
    /CHAT_ADMIN_CLERK_IDS/,
    "Admin API handler must check CHAT_ADMIN_CLERK_IDS allowlist"
  );
  
  // Must check if user is admin
  assert.match(
    adminApiBlock,
    /if\s*\(\s*!isAdminUser\s*\)/,
    "Admin API handler must check isAdminUser flag"
  );
  
  // Must return 403 Forbidden when not authorized
  assert.match(
    adminApiBlock,
    /status:\s*403/,
    "Admin API handler must return 403 for unauthorized requests"
  );
  
  assert.match(
    adminApiBlock,
    /Forbidden/,
    "Admin API handler must return 'Forbidden' error message"
  );
  
  // Must audit log the authorization failure
  assert.match(
    adminApiBlock,
    /auditLog\s*\(\s*["']admin_api_access_blocked["']/,
    "Admin API handler must audit log authorization failures"
  );
});

test("proxy: admin API handler enforces MFA step-up", () => {
  const proxy = read("src/proxy.ts");
  
  const adminApiStart = proxy.indexOf('if (pathname.startsWith("/api/admin"))');
  const adminApiEnd = proxy.indexOf("return applySecurityHeaders(NextResponse.next());", adminApiStart);
  const adminApiBlock = proxy.substring(adminApiStart, adminApiEnd + 100);
  
  // Must retrieve factorVerificationAge from auth()
  assert.match(
    adminApiBlock,
    /factorVerificationAge/,
    "Admin API handler must retrieve factorVerificationAge"
  );
  
  // Must check for admin MFA cookie
  assert.match(
    adminApiBlock,
    /ADMIN_MFA_COOKIE/,
    "Admin API handler must check ADMIN_MFA_COOKIE"
  );
  
  // Must check for user MFA cookie
  assert.match(
    adminApiBlock,
    /USER_MFA_COOKIE/,
    "Admin API handler must check USER_MFA_COOKIE"
  );
  
  // Must call hasRecentMfa()
  assert.match(
    adminApiBlock,
    /hasRecentMfa\s*\(\s*factorVerificationAge\s*\)/,
    "Admin API handler must call hasRecentMfa()"
  );
  
  // Must verify admin MFA token
  assert.match(
    adminApiBlock,
    /verifyAdminMfaToken/,
    "Admin API handler must call verifyAdminMfaToken()"
  );
  
  // Must verify user MFA token
  assert.match(
    adminApiBlock,
    /verifyUserMfaToken/,
    "Admin API handler must call verifyUserMfaToken()"
  );
  
  // Must check all three MFA conditions with AND logic (all must fail to reject)
  assert.match(
    adminApiBlock,
    /!hasRecentMfa.*&&.*!.*verifyAdminMfaToken.*&&.*!.*verifyUserMfaToken/s,
    "Admin API handler must require at least one MFA verification method"
  );
  
  // Must return 403 when MFA is not satisfied
  assert.match(
    adminApiBlock,
    /MFA required for admin access/,
    "Admin API handler must return 'MFA required' error message"
  );
  
  // Must audit log the MFA requirement
  assert.match(
    adminApiBlock,
    /auditLog\s*\(\s*["']admin_mfa_required["']/,
    "Admin API handler must audit log MFA requirement failures"
  );
});

test("proxy: userMfaGate explicitly skips all API paths", () => {
  const proxy = read("src/proxy.ts");
  
  // Find the userMfaGate function
  const userMfaGateStart = proxy.indexOf("async function userMfaGate(");
  assert.ok(userMfaGateStart > 0, "userMfaGate function should exist");
  
  // Find the early return conditions
  const userMfaGateBlock = proxy.substring(userMfaGateStart, userMfaGateStart + 1000);
  
  // Must skip all /api/ paths
  assert.match(
    userMfaGateBlock,
    /pathname\.startsWith\s*\(\s*["']\/api\/["']\s*\)/,
    "userMfaGate must skip all /api/ paths"
  );
  
  // Must return null for API paths (no MFA gate)
  assert.match(
    userMfaGateBlock,
    /return\s+null/,
    "userMfaGate must return null for skipped paths"
  );
});

test("proxy: public route matcher includes broad API pattern", () => {
  const proxy = read("src/proxy.ts");
  
  // Find the isPublicRoute matcher definition
  const publicRouteStart = proxy.indexOf("const isPublicRoute = createRouteMatcher([");
  assert.ok(publicRouteStart > 0, "isPublicRoute matcher should exist");
  
  const publicRouteEnd = proxy.indexOf("]);", publicRouteStart);
  const publicRouteBlock = proxy.substring(publicRouteStart, publicRouteEnd);
  
  // The broad /api/(.*) pattern should still exist (it's needed for other APIs)
  assert.match(
    publicRouteBlock,
    /["']\/api\/\(\.\*\)["']/,
    "Public route matcher should include /api/(.*) pattern"
  );
  
  // This confirms the vulnerability context: /api/admin/* WOULD match this
  // pattern if not handled earlier in the middleware chain
});

test("proxy: admin UI routes still have separate MFA check", () => {
  const proxy = read("src/proxy.ts");
  
  // Find the admin UI MFA check (after the public route branch)
  const adminUiMatch = proxy.match(
    /if\s*\(\s*pathname\.startsWith\s*\(\s*["']\/admin["']\s*\)\s*&&\s*pathname\s*!==\s*["']\/admin\/mfa-required["']\s*\)/
  );
  
  assert.ok(
    adminUiMatch,
    "Admin UI routes should have their own MFA check for defense in depth"
  );
  
  // The admin UI check should NOT include /api/admin anymore (that's handled earlier)
  const adminUiPos = adminUiMatch.index;
  const adminUiBlock = proxy.substring(adminUiPos, adminUiPos + 500);
  
  // Should NOT have the old pattern that included /api/admin
  assert.doesNotMatch(
    adminUiBlock,
    /pathname\.startsWith\s*\(\s*["']\/api\/admin["']\s*\)/,
    "Admin UI MFA check should NOT include /api/admin (handled earlier)"
  );
});

test("admin ban-user endpoint: has auth and admin checks (defense in depth)", () => {
  const file = read("src/app/api/admin/ban-user/route.ts");
  
  // Defense in depth: endpoint should still have its own checks
  assert.match(
    file,
    /await\s+auth\(\)/,
    "ban-user endpoint should call auth()"
  );
  
  assert.match(
    file,
    /if\s*\(\s*!userId\s*\)/,
    "ban-user endpoint should check userId"
  );
  
  assert.match(
    file,
    /await\s+isAdmin\s*\(\s*userId\s*\)/,
    "ban-user endpoint should call isAdmin()"
  );
  
  assert.match(
    file,
    /Unauthorized/,
    "ban-user endpoint should return Unauthorized for missing auth"
  );
  
  assert.match(
    file,
    /Forbidden/,
    "ban-user endpoint should return Forbidden for non-admins"
  );
  
  // The endpoint performs privileged mutation
  assert.match(
    file,
    /update\(users\)/,
    "ban-user endpoint should update users table"
  );
  
  assert.match(
    file,
    /isBanned/,
    "ban-user endpoint should modify isBanned field"
  );
});

test("admin toggle-admin endpoint: has auth and admin checks (defense in depth)", () => {
  const file = read("src/app/api/admin/users/[clerkId]/admin/route.ts");
  
  // Defense in depth: endpoint should still have its own checks
  assert.match(
    file,
    /await\s+auth\(\)/,
    "toggle-admin endpoint should call auth()"
  );
  
  assert.match(
    file,
    /if\s*\(\s*!userId\s*\)/,
    "toggle-admin endpoint should check userId"
  );
  
  assert.match(
    file,
    /await\s+isAdmin\s*\(\s*userId\s*\)/,
    "toggle-admin endpoint should call isAdmin()"
  );
  
  assert.match(
    file,
    /Unauthorized/,
    "toggle-admin endpoint should return Unauthorized for missing auth"
  );
  
  assert.match(
    file,
    /Forbidden/,
    "toggle-admin endpoint should return Forbidden for non-admins"
  );
  
  // The endpoint performs privileged mutation
  assert.match(
    file,
    /update\(users\)/,
    "toggle-admin endpoint should update users table"
  );
  
  assert.match(
    file,
    /\.isAdmin/,
    "toggle-admin endpoint should modify isAdmin field"
  );
});

test("proxy: admin API handler returns early with proper response", () => {
  const proxy = read("src/proxy.ts");
  
  const adminApiStart = proxy.indexOf('if (pathname.startsWith("/api/admin"))');
  const adminApiEnd = proxy.indexOf("return applySecurityHeaders(NextResponse.next());", adminApiStart);
  const adminApiBlock = proxy.substring(adminApiStart, adminApiEnd + 100);
  
  // After all checks pass, must return NextResponse.next() to allow the request
  assert.match(
    adminApiBlock,
    /return\s+applySecurityHeaders\s*\(\s*NextResponse\.next\(\)\s*\)/,
    "Admin API handler must return NextResponse.next() after successful checks"
  );
  
  // Must apply security headers to all responses - check the full block more carefully
  // The auth failure block spans multiple lines including the return statement
  assert.match(
    adminApiBlock,
    /if\s*\(\s*!userId\s*\)[\s\S]*?applySecurityHeaders[\s\S]*?status:\s*401/,
    "Auth failure response must apply security headers with 401 status"
  );
  
  assert.match(
    adminApiBlock,
    /if\s*\(\s*!isAdminUser\s*\)[\s\S]*?applySecurityHeaders[\s\S]*?status:\s*403/,
    "Admin check failure response must apply security headers with 403 status"
  );
});

test("proxy: comment explains the fix and vulnerability context", () => {
  const proxy = read("src/proxy.ts");
  
  const adminApiStart = proxy.indexOf('if (pathname.startsWith("/api/admin"))');
  // Look for comment in the 300 characters before the admin API check
  const commentBlock = proxy.substring(Math.max(0, adminApiStart - 300), adminApiStart);
  
  // Should have a comment explaining why this check comes before public routes
  assert.match(
    commentBlock,
    /Admin API routes.*authentication.*MFA.*step-up/is,
    "Should have comment explaining authentication and MFA step-up requirement"
  );
  
  assert.match(
    commentBlock,
    /BEFORE.*public.*route.*branch/is,
    "Should mention that admin API check comes BEFORE public route branch"
  );
  
  assert.match(
    commentBlock,
    /\/api\/\(\.\*\)/,
    "Should reference the broad /api/(.*) pattern that would otherwise match"
  );
});

test("proxy: admin API check is comprehensive and fail-closed", () => {
  const proxy = read("src/proxy.ts");
  
  const adminApiStart = proxy.indexOf('if (pathname.startsWith("/api/admin"))');
  const adminApiEnd = proxy.indexOf("return applySecurityHeaders(NextResponse.next());", adminApiStart);
  const adminApiBlock = proxy.substring(adminApiStart, adminApiEnd + 100);
  
  // Count the number of early returns (should be 3: auth, authz, MFA)
  const returnMatches = adminApiBlock.match(/return\s+applySecurityHeaders\s*\(/g);
  assert.ok(
    returnMatches && returnMatches.length >= 4,
    "Should have at least 4 returns: 3 failure cases + 1 success"
  );
  
  // All failure paths should return error responses with proper status codes
  assert.match(
    adminApiBlock,
    /if\s*\(\s*!userId\s*\)[\s\S]*?NextResponse\.json[\s\S]*?status:\s*401/,
    "Auth failure should return JSON error with 401 status"
  );
  
  assert.match(
    adminApiBlock,
    /if\s*\(\s*!isAdminUser\s*\)[\s\S]*?NextResponse\.json[\s\S]*?status:\s*403/,
    "Admin failure should return JSON error with 403 status"
  );
  
  // MFA failure check - look for the pattern with hasRecentMfa and status 403
  assert.match(
    adminApiBlock,
    /!hasRecentMfa[\s\S]*?NextResponse\.json[\s\S]*?MFA required[\s\S]*?status:\s*403/,
    "MFA failure should return JSON error with 403 status"
  );
});

test("security: admin API routes are protected at proxy level (not just handler level)", () => {
  const proxy = read("src/proxy.ts");
  
  // The key security property: admin API protection happens in the proxy/middleware,
  // which runs BEFORE any route handler. This means even if a handler has a bug,
  // the proxy layer provides defense in depth.
  
  const adminApiStart = proxy.indexOf('if (pathname.startsWith("/api/admin"))');
  assert.ok(
    adminApiStart > 0,
    "Admin API protection must exist at proxy/middleware level"
  );
  
  // The proxy check should be in the middlewareHandler function
  const middlewareHandlerStart = proxy.indexOf("const middlewareHandler = async");
  assert.ok(
    middlewareHandlerStart > 0 && middlewareHandlerStart < adminApiStart,
    "Admin API check must be inside middlewareHandler"
  );
  
  // The check should happen before any route handler is invoked
  // (middleware runs before route handlers in Next.js)
  // Look for the export statement that wraps the middleware
  const hasClerkMiddleware = proxy.includes("clerkMiddleware") && 
                             proxy.includes("export") &&
                             proxy.includes("middlewareHandler");
  assert.ok(
    hasClerkMiddleware,
    "Proxy should use clerkMiddleware wrapper with middlewareHandler"
  );
});
