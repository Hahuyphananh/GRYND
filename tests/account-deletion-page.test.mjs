/**
 * account-deletion-page.test.mjs
 *
 * Guards the page Google Play's Data deletion policy requires: a URL that
 * explains how to delete an account and is reachable WITHOUT signing in.
 *
 * The failure this suite prevents is the one a Play reviewer would hit, not a
 * visible one: the deletion feature exists and works, but only behind an auth
 * wall, so the submitted URL bounces a signed-out visitor to /sign-in and the
 * listing is rejected.
 *
 * It also keeps the page honest against the code it describes:
 * src/lib/security/deleteUserData.ts keeps three things on purpose (anonymised
 * reports filed against the user, audit logs, and the hashed rating identity),
 * and a page that promised a total erasure would be a false statement to users.
 *
 * Run:  npm run test:account-deletion
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isPublicRoute } from "../src/proxy.ts";
import { EXCLUDED_FROM_SITEMAP, PUBLIC_SEO_PATHS } from "../src/lib/seoPages.ts";

const PAGE = "src/app/account-deletion/page.tsx";
const PATH = "/account-deletion";
const read = (rel) => readFileSync(rel, "utf8");

test("the page exists at the submitted URL with its own metadata", () => {
  const src = read(PAGE);
  assert.match(src, /path: "\/account-deletion"/, "metadata must declare the canonical path");
  assert.match(src, /export const metadata/, "the page must publish metadata");
  assert.match(src, /title: "Delete your account"/);
});

test("a signed-out visitor can reach it — the requirement behind the URL", () => {
  // The proxy sends unauthenticated requests to protected routes to /sign-in.
  // Play checks the submitted URL as a stranger, so it must be public.
  assert.ok(
    isPublicRoute({ nextUrl: { pathname: PATH } }),
    `${PATH} is not a public route — a Play reviewer would be redirected to sign-in`
  );
});

test("it names the app and the account it deletes", () => {
  const src = read(PAGE);
  assert.match(src, /GRYND/, "the policy URL must name the app it applies to");
  assert.match(src, /Google Play/, "it should say which distribution it covers");
  assert.match(src, /Profile/);
  assert.match(src, /Danger zone/);
  assert.match(src, /Delete account/i);
});

test("it offers a route for users who can no longer sign in", () => {
  const src = read(PAGE);
  // Self-serve deletion needs a session; someone locked out needs a channel.
  assert.match(src, /href="\/contact"/, "a locked-out user needs a reachable contact channel");
  assert.match(src, /within 30 days/i, "the assisted path must state a response window");
});

test("what it promises matches what the purge actually keeps", () => {
  const purge = read("src/lib/security/deleteUserData.ts");
  const page = read(PAGE);

  // The purge anonymises reports filed against the user rather than deleting them.
  assert.match(purge, /DELETED_USER_SENTINEL/);
  assert.match(page, /anonymi[sz]ed/i, "the page must disclose the anonymised reports");

  // Audit logs are retained for legal reasons, by design.
  assert.match(purge, /admin_audit_logs are kept (fully )?intact/);
  assert.match(page, /audit logs/i);

  // The hashed rating identity survives deletion; saying so prevents a false
  // "everything is erased" claim.
  assert.match(purge, /rating_identities/);
  assert.match(page, /hash/i);

  // Deletion is immediate — the privacy policy already says so, and the route
  // has no waiting period to invent.
  assert.match(page, /right away|immediately/i);
});

test("it is a static, script-free page with no ad code", () => {
  const src = read(PAGE);
  assert.doesNotMatch(src, /"use client"/, "a policy page must not need hydration");
  assert.doesNotMatch(src, /AdSenseScript|AdSlot|adsbygoogle/, "policy pages carry no ad code");
  assert.doesNotMatch(src, /index: false/, "reviewers and users must be able to find it");
});

test("it is a footer-linked, declared exclusion from the sitemap inventory", () => {
  // Reachable from any page, not only from the Play listing.
  assert.match(read("src/components/Footer.tsx"), /href="\/account-deletion"/);

  // Classified rather than forgotten: the sitemap coverage test requires every
  // static route to be listed, excluded with a reason, or noindex.
  assert.ok(EXCLUDED_FROM_SITEMAP[PATH], `${PATH} must be classified in seoPages.ts`);
  assert.equal(PUBLIC_SEO_PATHS.includes(PATH), false, "a policy URL is not a search target");
});
