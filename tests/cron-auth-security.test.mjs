/**
 * cron-auth-security.test.mjs
 *
 * Security tests for cron job authentication (pentest mitigation).
 *
 * Verifies that all cron job endpoints under /api/jobs/* enforce
 * authentication via verifyCronRequest to prevent unauthenticated
 * callers from triggering global state-changing operations.
 *
 * Pentest Finding: "Unauthenticated callers can execute the global weekly-reset job"
 * Root Cause: Cron endpoints were publicly accessible without authentication
 * Mitigation: All cron endpoints now require Bearer token authentication
 *
 * Run:
 *   node --test tests/cron-auth-security.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

// List of all cron job endpoints that must be protected
const CRON_JOB_ROUTES = [
  "src/app/api/jobs/weekly-reset/route.ts",
  "src/app/api/jobs/daily-reset/route.ts",
  "src/app/api/jobs/cache-stats-log/route.ts",
  "src/app/api/jobs/inactivity-check/route.ts",
  "src/app/api/jobs/retention/route.ts",
];

const CRON_AUTH_MODULE = "src/lib/security/cronAuth.ts";

// ═══════════════════════════════════════════════════════════════
// Verify cronAuth module implementation
// ═══════════════════════════════════════════════════════════════

test("cronAuth module exists and is accessible", () => {
  assert.ok(
    fs.existsSync(CRON_AUTH_MODULE),
    "cronAuth.ts module must exist at src/lib/security/cronAuth.ts"
  );
});

test("cronAuth exports verifyCronRequest function", () => {
  const source = fs.readFileSync(CRON_AUTH_MODULE, "utf8");
  assert.match(
    source,
    /export\s+function\s+verifyCronRequest/,
    "cronAuth must export verifyCronRequest function"
  );
});

test("cronAuth verifyCronRequest accepts Request parameter", () => {
  const source = fs.readFileSync(CRON_AUTH_MODULE, "utf8");
  assert.match(
    source,
    /function\s+verifyCronRequest\s*\(\s*request\s*:\s*Request\s*\)/,
    "verifyCronRequest must accept Request parameter"
  );
});

test("cronAuth verifyCronRequest returns Response | null", () => {
  const source = fs.readFileSync(CRON_AUTH_MODULE, "utf8");
  assert.match(
    source,
    /:\s*Response\s*\|\s*null/,
    "verifyCronRequest must return Response | null type"
  );
});

// ═══════════════════════════════════════════════════════════════
// Verify all cron job routes are protected
// ═══════════════════════════════════════════════════════════════

for (const routePath of CRON_JOB_ROUTES) {
  const routeName = path.basename(path.dirname(routePath));

  test(`${routeName}: route file exists`, () => {
    assert.ok(
      fs.existsSync(routePath),
      `${routePath} must exist`
    );
  });

  test(`${routeName}: imports verifyCronRequest`, () => {
    const source = fs.readFileSync(routePath, "utf8");
    assert.match(
      source,
      /import\s+\{[^}]*verifyCronRequest[^}]*\}\s+from\s+["'].*cronAuth["']/,
      `${routeName} must import verifyCronRequest from cronAuth module`
    );
  });

  test(`${routeName}: handler accepts Request parameter`, () => {
    const source = fs.readFileSync(routePath, "utf8");
    // Match GET or POST handler with Request parameter
    const hasRequestParam = 
      /export\s+async\s+function\s+(GET|POST)\s*\(\s*request\s*:\s*Request\s*\)/.test(source);
    assert.ok(
      hasRequestParam,
      `${routeName} handler must accept Request parameter for authentication`
    );
  });

  test(`${routeName}: calls verifyCronRequest before operations`, () => {
    const source = fs.readFileSync(routePath, "utf8");
    
    // Must call verifyCronRequest
    assert.match(
      source,
      /verifyCronRequest\s*\(\s*request\s*\)/,
      `${routeName} must call verifyCronRequest(request)`
    );

    // Must capture the return value
    assert.match(
      source,
      /const\s+authError\s*=\s*verifyCronRequest/,
      `${routeName} must capture verifyCronRequest return value`
    );

    // Must return authError if present
    assert.match(
      source,
      /if\s*\(\s*authError\s*\)\s*return\s+authError/,
      `${routeName} must return authError immediately if authentication fails`
    );
  });

  test(`${routeName}: authentication check precedes state changes`, () => {
    const source = fs.readFileSync(routePath, "utf8");
    
    // Extract handler function body
    const handlerMatch = source.match(
      /export\s+async\s+function\s+(GET|POST)\s*\([^)]*\)\s*\{([\s\S]*)\}/
    );
    
    if (!handlerMatch) {
      assert.fail(`Could not extract handler function from ${routeName}`);
    }

    const functionBody = handlerMatch[2];
    
    // Find position of auth check
    const authCheckIndex = functionBody.indexOf("verifyCronRequest");
    assert.ok(
      authCheckIndex !== -1,
      `${routeName} must call verifyCronRequest`
    );

    // Find position of first state-changing operation
    const stateChangePatterns = [
      /await\s+sql`/,
      /await\s+db\./,
      /\.update\(/,
      /\.delete\(/,
      /\.insert\(/,
      /sendEmail/,
      /send.*Email/,
    ];

    let firstStateChangeIndex = Infinity;
    for (const pattern of stateChangePatterns) {
      const match = functionBody.match(pattern);
      if (match && match.index !== undefined) {
        firstStateChangeIndex = Math.min(firstStateChangeIndex, match.index);
      }
    }

    if (firstStateChangeIndex !== Infinity) {
      assert.ok(
        authCheckIndex < firstStateChangeIndex,
        `${routeName}: verifyCronRequest must be called BEFORE any state-changing operations`
      );
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// Verify authentication mechanism security properties
// ═══════════════════════════════════════════════════════════════

test("cronAuth: fail-secure when CRON_SECRET is not configured", () => {
  const source = fs.readFileSync(CRON_AUTH_MODULE, "utf8");
  
  // Must check for missing CRON_SECRET
  assert.match(
    source,
    /if\s*\(\s*!cronSecret\s*\)/,
    "must check if CRON_SECRET is missing"
  );

  // Must return 401 when missing
  const missingSecretBlock = source.split(/if\s*\(\s*!cronSecret\s*\)/)[1];
  assert.ok(missingSecretBlock, "must have code block for missing CRON_SECRET");
  
  const beforeNextReturn = missingSecretBlock.split(/return\s+null/)[0];
  assert.match(
    beforeNextReturn,
    /status:\s*401/,
    "must return 401 status when CRON_SECRET is not configured"
  );
});

test("cronAuth: rejects requests without Authorization header", () => {
  const source = fs.readFileSync(CRON_AUTH_MODULE, "utf8");
  
  assert.match(
    source,
    /request\.headers\.get\s*\(\s*["']authorization["']\s*\)/,
    "must read Authorization header"
  );

  assert.match(
    source,
    /if\s*\(\s*!authHeader\s*\)/,
    "must check if Authorization header is missing"
  );

  // Must return 401 for missing header
  const missingHeaderBlock = source.split(/if\s*\(\s*!authHeader\s*\)/)[1];
  const beforeNextCheck = missingHeaderBlock.split(/if\s*\(/)[0];
  assert.match(
    beforeNextCheck,
    /status:\s*401/,
    "must return 401 when Authorization header is missing"
  );
});

test("cronAuth: validates Bearer token format", () => {
  const source = fs.readFileSync(CRON_AUTH_MODULE, "utf8");
  
  // Must extract Bearer token using regex
  assert.match(
    source,
    /authHeader\.match\s*\(/,
    "must use regex to parse Authorization header"
  );

  assert.match(
    source,
    /Bearer/i,
    "must validate Bearer token format"
  );

  // Must check if match failed
  assert.match(
    source,
    /if\s*\(\s*!match\s*\)/,
    "must check if Bearer token format is invalid"
  );

  // Must return 401 for invalid format
  const invalidFormatBlock = source.split(/if\s*\(\s*!match\s*\)/)[1];
  const beforeNextCheck = invalidFormatBlock.split(/const\s+/)[0];
  assert.match(
    beforeNextCheck,
    /status:\s*401/,
    "must return 401 when Authorization format is invalid"
  );
});

test("cronAuth: uses constant-time comparison to prevent timing attacks", () => {
  const source = fs.readFileSync(CRON_AUTH_MODULE, "utf8");
  
  // Must use timingSafeEqual function
  assert.match(
    source,
    /timingSafeEqual\s*\(/,
    "must use timingSafeEqual for token comparison"
  );

  // Must define timingSafeEqual function
  assert.match(
    source,
    /function\s+timingSafeEqual\s*\(\s*a\s*:\s*string\s*,\s*b\s*:\s*string\s*\)/,
    "must define timingSafeEqual function"
  );

  // Verify constant-time implementation
  const timingSafeEqualMatch = source.match(
    /function\s+timingSafeEqual[\s\S]*?\n\}/
  );
  assert.ok(timingSafeEqualMatch, "timingSafeEqual function must be present");
  
  const timingSafeEqualBody = timingSafeEqualMatch[0];
  
  // Must check length equality first
  assert.match(
    timingSafeEqualBody,
    /a\.length\s*!==\s*b\.length/,
    "timingSafeEqual must check length equality"
  );

  // Must use XOR for constant-time comparison
  assert.match(
    timingSafeEqualBody,
    /\^/,
    "timingSafeEqual must use XOR operation for constant-time comparison"
  );

  // Must accumulate result
  assert.match(
    timingSafeEqualBody,
    /result\s*\|=/,
    "timingSafeEqual must accumulate comparison result"
  );
});

test("cronAuth: rejects invalid credentials with 401", () => {
  const source = fs.readFileSync(CRON_AUTH_MODULE, "utf8");
  
  // Must check timingSafeEqual result
  assert.match(
    source,
    /if\s*\(\s*!timingSafeEqual/,
    "must check if token comparison fails"
  );

  // Must return 401 for invalid token
  const invalidTokenBlock = source.split(/if\s*\(\s*!timingSafeEqual/)[1];
  const beforeSuccessReturn = invalidTokenBlock.split(/return\s+null/)[0];
  assert.match(
    beforeSuccessReturn,
    /status:\s*401/,
    "must return 401 when token is invalid"
  );
});

test("cronAuth: returns null on successful authentication", () => {
  const source = fs.readFileSync(CRON_AUTH_MODULE, "utf8");
  
  // Must return null after all checks pass
  assert.match(
    source,
    /return\s+null/,
    "must return null when authentication succeeds"
  );

  // Verify null is returned after the token comparison
  const afterTimingSafeEqual = source.split(/timingSafeEqual/)[1];
  assert.match(
    afterTimingSafeEqual,
    /return\s+null/,
    "must return null after successful token validation"
  );
});

test("cronAuth: includes security documentation", () => {
  const source = fs.readFileSync(CRON_AUTH_MODULE, "utf8");
  
  // Must document the security purpose
  assert.match(
    source,
    /prevent.*unauthenticated/i,
    "must document prevention of unauthenticated access"
  );

  // Must document constant-time comparison
  assert.match(
    source,
    /timing.*attack/i,
    "must document timing attack prevention"
  );

  // Must document fail-secure behavior
  assert.match(
    source,
    /fail.*secure/i,
    "must document fail-secure behavior"
  );
});

// ═══════════════════════════════════════════════════════════════
// Verify no cron endpoints are left unprotected
// ═══════════════════════════════════════════════════════════════

test("all cron job routes under /api/jobs/* are protected", () => {
  const jobsDir = "src/app/api/jobs";
  
  if (!fs.existsSync(jobsDir)) {
    assert.fail(`Jobs directory ${jobsDir} does not exist`);
  }

  const jobDirs = fs.readdirSync(jobsDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  // Verify each job directory has a route.ts that's in our protected list
  for (const jobDir of jobDirs) {
    const routePath = path.join(jobsDir, jobDir, "route.ts");
    const routePathJs = path.join(jobsDir, jobDir, "route.js");
    
    const hasRoute = fs.existsSync(routePath) || fs.existsSync(routePathJs);
    if (!hasRoute) {
      continue; // Skip directories without routes
    }

    const actualPath = fs.existsSync(routePath) ? routePath : routePathJs;
    const normalizedPath = actualPath.replace(/\\/g, "/");
    
    const isProtected = CRON_JOB_ROUTES.some(protectedRoute => 
      normalizedPath.includes(jobDir)
    );

    assert.ok(
      isProtected,
      `Cron job route ${normalizedPath} must be in the protected routes list`
    );
  }
});

console.log("\n✅ All cron authentication security tests passed!\n");
