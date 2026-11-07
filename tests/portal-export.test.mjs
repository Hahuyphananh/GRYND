// tests/portal-export.test.mjs
//
// Portal export catalog + launcher/manifest builders + the CLI that writes them.
//
//   1. Only games a signed-out visitor can actually play are exportable, and
//      that list is pinned to the server's guest practice list.
//   2. The launcher is safe and portal-shaped: https only, escaped, one iframe,
//      no SDK script from a CDN, no secrets.
//   3. The manifest says what each portal requires, including the ones where a
//      hosted GRYND URL is NOT a valid submission (Poki).
//   4. The CLI writes exactly two files per portal + game and fails closed.
//
//   npm run test:portal-export

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  PORTALS,
  PORTAL_EXPORT_GAMES,
  PORTAL_EXPORT_FORMAT,
  PORTAL_EXPORT_VERSION,
  PORTAL_QUERY_PARAM,
  PORTAL_SLUGS,
  buildExportFiles,
  buildExportManifest,
  buildLauncherHtml,
  escapeHtml,
  getPortalExportGame,
  normalizePortalBaseUrl,
  portalGameUrl,
} from "../src/lib/portal/catalog.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = "https://www.grynd.example";

// ── 1. The exportable games ────────────────────────────────────────────────

test("only guest-playable games are exported", () => {
  const writer = fs.readFileSync(
    path.join(ROOT, "src/lib/guest/practiceProgress.ts"),
    "utf8",
  );
  const guestKeys = [
    ...writer.matchAll(/export const GUEST_PRACTICE_[A-Z_]*GAME_KEY = "([a-z0-9-]+)"/g),
  ]
    .map((match) => match[1])
    .sort();

  assert.ok(guestKeys.length >= 4, `expected the server guest list, got ${guestKeys}`);

  const exportKeys = PORTAL_EXPORT_GAMES.map((game) => game.gameKey).sort();

  // Every game whose practice results are written for guests must be exportable.
  for (const key of guestKeys) {
    assert.ok(exportKeys.includes(key), `${key} is guest-playable but not exported`);
  }

  // Beyond that the catalog is a REVIEWED list, not a mirror of the guest list: a
  // game qualifies when its practice mode accepts a signed-out visitor even if
  // it writes no guest progress. Solitaire Duel is that case, and the test below
  // proves it from the endpoint rather than taking this entry's word for it.
  assert.deepEqual(
    exportKeys,
    [...guestKeys, "solitaire-duel"].sort(),
    "only reviewed, guest-playable games may be exported",
  );

  for (const game of PORTAL_EXPORT_GAMES) {
    assert.equal(game.mode, "practice");
    assert.equal(game.requiresAccount, false, `${game.gameKey} must not need an account`);
    assert.match(game.route, /^\/casino\/[a-z0-9-]+$/);
    // A portal loads the chrome-free surface, and it names this exact game.
    assert.equal(game.playRoute, `/play/${game.gameKey}`);
    // One dynamic route serves all four (src/app/play/[gameKey]); the page
    // validates the key against this catalog before rendering.
    assert.equal(
      fs.existsSync(path.join(ROOT, "src/app/play/[gameKey]/page.tsx")),
      true,
      "the portal surface route is missing",
    );
    assert.ok(game.name.trim().length > 0);
    // The route must be a real page, not a guess.
    assert.ok(
      fs.existsSync(path.join(ROOT, "src/app", game.route.replace(/^\//, ""), "page.tsx")) ||
        fs.existsSync(path.join(ROOT, "src/app", game.route.replace(/^\//, ""), "page.jsx")),
      `${game.route} has no page`,
    );
  }
});

test("an exported game without guest progress still accepts a guest", () => {
  const progress = fs.readFileSync(
    path.join(ROOT, "src/lib/guest/practiceProgress.ts"),
    "utf8",
  );
  const guestKeys = [
    ...progress.matchAll(/export const GUEST_PRACTICE_[A-Z_]*GAME_KEY = "([a-z0-9-]+)"/g),
  ].map((match) => match[1]);

  let verified = 0;
  for (const game of PORTAL_EXPORT_GAMES) {
    if (guestKeys.includes(game.gameKey)) continue;

    const endpoint = path.join(ROOT, "src/app/api", game.gameKey, "create-ai", "route.ts");
    assert.ok(
      fs.existsSync(endpoint),
      `${game.gameKey} is exported with no guest progress and has no create-ai route to check`,
    );
    assert.match(
      fs.readFileSync(endpoint, "utf8"),
      /requirePracticePlayer\(\{ create: true \}\)/,
      `${game.gameKey} is exported but cannot start practice for a signed-out visitor`,
    );
    verified += 1;
  }

  // The reviewed exception exists, and it was actually checked.
  assert.ok(verified >= 1, "expected at least one reviewed non-progress export");
});

test("the catalog is closed: unknown games are refused", () => {
  assert.equal(getPortalExportGame("chess"), null);
  assert.equal(getPortalExportGame(null), null);
  assert.equal(
    portalGameUrl({ gameKey: "chess", baseUrl: BASE, portal: "itch" }),
    null,
  );
});

// ── 2. The portals we target ───────────────────────────────────────────────

test("every portal declares hosting, SDK and framing facts", () => {
  assert.deepEqual([...PORTAL_SLUGS].sort(), ["crazygames", "itch", "poki"]);

  for (const slug of PORTAL_SLUGS) {
    const spec = PORTALS[slug];
    assert.ok(spec.label);
    assert.ok(["upload-zip", "external-url", "both"].includes(spec.hosting));
    assert.ok(spec.submissionUrl.startsWith("https://"));
    assert.ok(spec.requirements.length >= 3);

    // A frame-ancestors entry is either an exact https origin or a subdomain
    // wildcard — never a bare "*".
    for (const ancestor of spec.frameAncestors) {
      assert.notEqual(ancestor, "*");
      assert.match(ancestor, /^https:\/\/(\*\.)?[a-z0-9.-]+$/);
    }
  }
});

test("Poki is not an iframe submission and CrazyGames is", () => {
  // Poki hosts the build itself: no framing, upload only.
  assert.equal(PORTALS.poki.hosting, "upload-zip");
  assert.deepEqual([...PORTALS.poki.frameAncestors], []);
  assert.match(PORTALS.poki.requirements.join(" "), /blocks|blocks external|External requests/i);

  // CrazyGames documents externally hosted (iframe) as a submission mode.
  assert.equal(PORTALS.crazygames.hosting, "both");
  assert.ok(PORTALS.crazygames.frameAncestors.some((o) => o.includes("crazygames.com")));
  assert.match(PORTALS.crazygames.requirements.join(" "), /iframe/i);

  // itch.io requires no SDK at all.
  assert.equal(PORTALS.itch.sdk, null);
  assert.equal(PORTALS.itch.hosting, "both");
});

// ── 3. URLs and escaping ──────────────────────────────────────────────────

test("the exported URL is https, portal-tagged and cannot be hijacked", () => {
  assert.equal(
    portalGameUrl({ gameKey: "dominoes", baseUrl: BASE, portal: "itch" }),
    `${BASE}/play/dominoes?${PORTAL_QUERY_PARAM}=itch`,
  );
  // A deployment subpath is preserved, a trailing slash is not doubled.
  assert.equal(
    portalGameUrl({ gameKey: "odds", baseUrl: "https://grynd.example/app/", portal: "poki" }),
    `https://grynd.example/app/play/odds?${PORTAL_QUERY_PARAM}=poki`,
  );

  for (const bad of [
    "http://grynd.example", // not https
    "javascript:alert(1)",
    "https://user:pass@grynd.example",
    "https://*.grynd.example",
    "https://grynd.example?x=1",
    "https://grynd.example#top",
    "not a url",
    "",
    null,
  ]) {
    assert.equal(normalizePortalBaseUrl(bad), null, String(bad));
  }

  assert.equal(portalGameUrl({ gameKey: "dominoes", baseUrl: BASE, portal: "y8" }), null);
});

test("launcher text is escaped", () => {
  assert.equal(escapeHtml('<script>"&\'</script>'), "&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;");
});

// ── 4. The launcher page ──────────────────────────────────────────────────

test("the launcher is one escaped, full-viewport iframe with no secrets", () => {
  const html = buildLauncherHtml({ gameKey: "tic-tac-toe", portal: "crazygames", baseUrl: BASE });
  assert.ok(html);

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<meta name="robots" content="noindex"/);
  assert.match(html, /allow="fullscreen; autoplay; gamepad; clipboard-write"/);
  assert.match(html, /referrerpolicy="strict-origin-when-cross-origin"/);
  assert.match(
    html,
    new RegExp(`src="${BASE}/play/tic-tac-toe\\?${PORTAL_QUERY_PARAM}=crazygames"`),
  );

  // No wrapper-side SDK: the SDK belongs inside the game document.
  assert.doesNotMatch(html, /<script[^>]+src=/);
  // Nothing secret, identifying or credential-like is written into an upload.
  assert.doesNotMatch(html, /token|secret|cookie|guest_|authorization/i);
});

test("the launcher refuses to build for an unusable target", () => {
  assert.equal(
    buildLauncherHtml({ gameKey: "dominoes", portal: "itch", baseUrl: "http://grynd.example" }),
    null,
  );
  assert.equal(
    buildLauncherHtml({ gameKey: "chess", portal: "itch", baseUrl: BASE }),
    null,
  );
});

// ── 5. The manifest ───────────────────────────────────────────────────────

test("the manifest states the hosting shape and the SDK each portal needs", () => {
  const itch = buildExportManifest({
    gameKey: "dominoes",
    portal: "itch",
    baseUrl: BASE,
    generatedAt: "2026-11-06T00:00:00.000Z",
  });
  assert.ok(itch);
  assert.equal(itch.format, PORTAL_EXPORT_FORMAT);
  assert.equal(itch.version, PORTAL_EXPORT_VERSION);
  assert.equal(itch.hosting, "both");
  assert.equal(itch.sdk.required, false);
  assert.equal(itch.game.key, "dominoes");
  assert.equal(itch.game.playRoute, "/play/dominoes");
  assert.equal(itch.game.mode, "practice");
  assert.equal(itch.entry, "index.html");
  assert.ok(itch.frameAncestors.includes("https://html.itch.zone"));

  const poki = buildExportManifest({
    gameKey: "battleship",
    portal: "poki",
    baseUrl: BASE,
    generatedAt: "2026-11-06T00:00:00.000Z",
  });
  assert.ok(poki);
  assert.equal(poki.hosting, "upload-zip");
  assert.equal(poki.sdk.required, true);
  assert.deepEqual(poki.frameAncestors, []);
  assert.match(poki.requirements.join(" "), /Poki hosts the build/i);

  // Uploadable JSON only — no credential material anywhere.
  assert.doesNotMatch(JSON.stringify(poki), /secret|token|cookie|guest_/i);
});

// ── 6. The CLI ────────────────────────────────────────────────────────────

test("the CLI writes index.html + manifest.json for the requested pair", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "grynd-portal-export-"));
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(ROOT, "scripts/export-portal.mjs"),
      "--game",
      "dominoes",
      "--portal",
      "itch",
      "--base-url",
      BASE,
      "--out",
      out,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const dir = path.join(out, "itch", "dominoes");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["index.html", "manifest.json"]);

  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  assert.match(html, new RegExp(`${BASE}/play/dominoes\\?portal=itch`));

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.game.key, "dominoes");
  assert.equal(manifest.portal, "itch");
  assert.equal(manifest.url, `${BASE}/play/dominoes?portal=itch`);

  fs.rmSync(out, { recursive: true, force: true });
});

test("the CLI fails closed instead of writing a bad export", () => {
  const run = (...args) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", path.join(ROOT, "scripts/export-portal.mjs"), ...args],
      { cwd: ROOT, encoding: "utf8" },
    );

  // No https origin: refuse, and write nothing.
  const noBase = run("--game", "dominoes", "--portal", "itch");
  assert.equal(noBase.status, 2);
  assert.match(noBase.stderr, /--base-url/);

  // Unknown game / portal: refuse.
  assert.equal(run("--game", "chess", "--portal", "itch", "--base-url", BASE).status, 2);
  assert.equal(run("--game", "dominoes", "--portal", "y8", "--base-url", BASE).status, 2);
  // Nothing selected: refuse rather than export everything by accident.
  assert.equal(run("--portal", "itch", "--base-url", BASE).status, 2);

  // --help is a clean exit.
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--base-url/);
});

test("buildExportFiles breaks on an unusable pair", () => {
  assert.equal(
    buildExportFiles({ gameKey: "dominoes", portal: "itch", baseUrl: "ftp://nope" }),
    null,
  );
  const files = buildExportFiles({ gameKey: "odds", portal: "poki", baseUrl: BASE });
  assert.ok(files);
  assert.deepEqual(Object.keys(files).sort(), ["index.html", "manifest.json"]);
});
