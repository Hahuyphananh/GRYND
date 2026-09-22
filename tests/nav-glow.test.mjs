// tests/nav-glow.test.mjs
//
// Contract tests for the navbar name glow.
//
// The bug: the equipped name glow (a Battle Pass reward) rendered on the
// profile card but never in the navbar. /api/get-user-tokens has always
// returned it — `glowColor` is the left-joined catalog colour of
// `users.selectedGlow` — but the navbar's profile state only carried the
// username EFFECT, so there was nothing to paint. Both name nodes — the desktop
// one and the mobile-menu one — had to be fixed together, which is exactly the
// kind of pairing that silently regresses.
//
// qa/nav-glow-check.mjs proves the rendered result; these pin the wiring.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const NAV = join(here, "..", "src/components/navigation-bar.jsx");
const src = readFileSync(NAV, "utf8");

test("the navbar reads the glow from the balance payload it already fetches", () => {
  // No second request: /api/get-user-tokens resolves the glow server-side and
  // the navbar has always received it.
  assert.match(
    src,
    /glowColor: data\.data\.glowColor \|\| null/,
    "the navbar must take the glow from its own profile fetch",
  );
  assert.doesNotMatch(
    src,
    /fetch\("\/api\/user\/glows"/,
    "a per-page-load extra call for a cosmetic is not needed",
  );
});

test("the glow colour comes from the server, never from the chat colour", () => {
  // `nameColor` deliberately falls back to the Grynd+ chat colour; painting the
  // display name with it would make every Grynd+ member's name glow a colour
  // they never equipped.
  assert.doesNotMatch(src, /glowColor: data\.data\.nameColor/);
  const route = readFileSync(
    join(here, "..", "src/app/api/get-user-tokens/route.ts"),
    "utf8",
  );
  assert.match(
    route,
    /glowColor: user\.glowColor \|\| null/,
    "the tokens route must expose the equipped glow on its own",
  );
  // …and the glow is the enabled catalog row for the selected key, not a
  // client-supplied value.
  assert.match(route, /glowColor: glows\.color/);
  assert.match(route, /eq\(glows\.key, users\.selectedGlow\)/);
  assert.match(route, /eq\(glows\.enabled, true\)/);
});

test("every place the name renders applies the glow", () => {
  const nameNodes = (src.match(/data-testid="nav-user-name"/g) ?? []).length;
  const namesWithGlow = (src.match(/style=\{nameGlowStyle\}/g) ?? []).length;
  assert.ok(nameNodes >= 2, `expected the desktop + menu name nodes, found ${nameNodes}`);
  assert.equal(
    namesWithGlow,
    nameNodes,
    `${nameNodes} name nodes but only ${namesWithGlow} render the glow — the menu one will drift`,
  );
});

test("the glow is a colour plus its halo, exactly like the profile card", () => {
  assert.match(
    src,
    /textShadow: `0 0 12px \$\{profile\.glowColor\}66`/,
    "the profile card's halo (12px, 40% alpha) must be the one the navbar uses",
  );
  assert.match(
    src,
    /const nameGlowStyle = profile\.glowColor\s*\?\s*\{/,
    "no glow equipped must leave the stylesheet colour alone (undefined style)",
  );
});

test("a glow equipped on the profile page reaches the navbar without a reload", () => {
  // The glow picker dispatches `profileUpdated`; the navbar re-fetches the
  // balance on it, which carries the new glow.
  assert.match(src, /const handler = \(\) => fetchBalance\(\{ includeMeta: false \}\)/);
  assert.match(src, /window\.addEventListener\("profileUpdated", handler\)/);
});

test("the glow is never read from client-side storage or the Clerk user", () => {
  // A glow is an owned, server-validated reward: taking a colour from
  // localStorage or the Clerk profile would let anyone paint their name.
  assert.doesNotMatch(src, /localStorage\.getItem\([^)]*glow/i);
  assert.doesNotMatch(src, /user\??\.\w*glow/i);
});
