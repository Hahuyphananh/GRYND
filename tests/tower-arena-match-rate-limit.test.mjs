/**
 * tower-arena-match-rate-limit.test.mjs
 *
 * The bug: a live Tower Arena duel (vs AI or PvP) ended on a permanent
 * "Match unavailable" screen, with a 429 in the console.
 *
 * Two defects combined:
 *
 *   1. GET /api/tower-arena/get-match sat in the generic API bucket
 *      (120/min per IP, 60/min per user). The match page reads on every socket
 *      push and in one bounded six-read burst per stamped turn deadline, so a
 *      fast duel could spend that budget by itself.
 *   2. The client turned ANY non-ok body into a fatal error. A 429 body has no
 *      `ok`, so the rate limit became "Match unavailable", and `error` was
 *      never cleared — the match stayed dead even after the window reset.
 *
 * What this pins:
 *   * only 429 is retryable for this policy, and the retry delay honours
 *     Retry-After with sane bounds;
 *   * the proxy gives tower-arena traffic its own bucket BEFORE the generic
 *     `/api/` rule, with enough headroom for the read pattern;
 *   * the page checks the rate limit before the fatal branch, keeps the board,
 *     schedules one retry, and clears `error` on a later success.
 *
 * Run: node --import tsx --test tests/tower-arena-match-rate-limit.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MATCH_RATE_LIMIT_RETRY_MAX_MS,
  MATCH_RATE_LIMIT_RETRY_MS,
  isRateLimitedMatchRead,
  rateLimitRetryDelayMs,
} from "../src/lib/tower-arena/matchFetch.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const PROXY = read("src/proxy.ts");
const PAGE = read("src/app/casino/tower-arena/game/[matchId]/PageClient.tsx");

test("only a 429 is retryable; auth/404 failures stay fatal", () => {
  assert.equal(isRateLimitedMatchRead(429), true);
  for (const status of [200, 400, 401, 403, 404, 409, 500, 502, 503]) {
    assert.equal(isRateLimitedMatchRead(status), false, `${status} must not be retried as a rate limit`);
  }
});

test("retry delay follows Retry-After, with a floor and a ceiling", () => {
  assert.equal(rateLimitRetryDelayMs(7), 7_000);
  assert.equal(rateLimitRetryDelayMs("3"), 3_000);
  assert.equal(rateLimitRetryDelayMs("2, proxy"), 2_000);
  assert.equal(rateLimitRetryDelayMs(0.2), 1_000, "never retry sooner than 1s");
  assert.equal(rateLimitRetryDelayMs(600), MATCH_RATE_LIMIT_RETRY_MAX_MS);
  assert.equal(rateLimitRetryDelayMs(undefined), MATCH_RATE_LIMIT_RETRY_MS);
  assert.equal(rateLimitRetryDelayMs("not-a-number"), MATCH_RATE_LIMIT_RETRY_MS);
  assert.equal(rateLimitRetryDelayMs(-5), MATCH_RATE_LIMIT_RETRY_MS);
});

test("tower arena match traffic has its own bucket before the generic /api/ rule", () => {
  const tower = PROXY.indexOf("pattern: /^\\/api\\/tower-arena\\//");
  const generic = PROXY.lastIndexOf("{ pattern: /^\\/api\\//");
  assert.ok(tower > -1, "the tower-arena rate-limit rule must exist");
  assert.ok(generic > tower, "it must be checked before the generic /api/ bucket");

  const block = PROXY.slice(tower, tower + 700);
  assert.match(block, /windowMs: 60_000/);
  const max = Number(/max:\s*(\d+)/.exec(block)?.[1]);
  assert.ok(max >= 600, `the match read bucket needs headroom, got ${max}/min`);
});

test("the match page treats a 429 as a retry, not as a dead match", () => {
  const rateBranch = PAGE.indexOf("isRateLimitedMatchRead(res.status)");
  const fatal = PAGE.indexOf('setError(data?.message || "Could not load match")');

  assert.ok(rateBranch > -1, "the page must detect the rate limit");
  assert.ok(fatal > rateBranch, "the fatal branch must run only after the rate-limit branch is skipped");
  assert.equal(PAGE.includes("setError(data.message"), false, "no unconditional fatal error on the raw body");

  assert.match(PAGE, /rateLimitRetryDelayMs\(retryAfter\)/);
  assert.match(PAGE, /data\?\.retryAfterSeconds \?\? res\.headers\.get\("Retry-After"\)/);
  assert.match(PAGE, /void loadRef\.current\(\)/, "the retry must re-read the match");
  assert.match(PAGE, /setError\(null\)/, "a later successful read must clear an earlier error");
  assert.match(PAGE, /window\.clearTimeout\(retryReadTimer\.current\)/, "retries must not stack or outlive the page");
});
