#!/usr/bin/env node
// scripts/package-itch-memory-grid.mjs
//
// `npm run package:itch:memory-grid` — the itch.io deliverable, in one command.
//
//   1. builds the standalone game with the GRYND sign-in CTA ON and any portal
//      SDK off,
//   2. refuses to continue unless that build actually produced a package,
//   3. zips it with index.html at the archive root (scripts/zip-portal-package.mjs),
//   4. reads the archive back and proves its contents before printing the summary.
//
// Step 1 forces the environment rather than trusting it: `PORTAL_CTA`,
// `PORTAL_CTA_URL` and `PORTAL_SDK` are overwritten for the build process, so
// the deliverable always carries exactly the CTA below — the GRYND sign-in route
// — and no SDK, whatever a developer's shell or a stray .env says.
//
// The archive is verified here, not just created: a packer bug that skips an
// asset is invisible until a portal serves a half-working game.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { readZip } from "./lib/zip-read.mjs";
import { zipDirectory } from "./zip-portal-package.mjs";

const ROOT = process.cwd();
const PACKAGE_DIR = resolve(ROOT, "dist/portal/memory-grid");
const OUT_FILE = resolve(ROOT, "dist/packages/memory-grid-itch.zip");
const VITE_BIN = resolve(ROOT, "node_modules/vite/bin/vite.js");
const VITE_CONFIG = resolve(ROOT, "standalone/memory-grid/vite.config.mts");

/**
 * Files a portal build must contain. Memory Grid ships no icon set beyond the
 * favicon, so this list is short — the tile face is checked separately below.
 */
const REQUIRED = ["index.html", "favicon.svg"];

/**
 * The one GRYND surface an itch.io package ships: the post-match CTA. The build
 * is configured here, not by the environment, so every deliverable is identical.
 * The destination is the production sign-in route
 * (`src/app/sign-in/[[...sign-in]]`, allow-listed in `src/proxy.ts`) — an
 * existing page, not an invented one.
 */
const CTA_URL = "https://www.grynd.dedyn.io/sign-in";
const CTA_LABEL = "Sign in to GRYND";
const CTA_QUESTION = "Want to track your stats and compete in ranked games?";

/**
 * Strings that must not exist in a package uploaded to itch.io: GRYND's
 * production surface (the CTA destination above is the sole exception), and any
 * portal SDK.
 */
const FORBIDDEN = [
  "sdk.crazygames.com",
  "/api/",
  "clerk",
  "supabase",
  "oracle",
  "socket.io",
  "posthog",
  "sentry",
  "adsbygoogle",
  "googletag",
  "monetag",
  "umami",
];

function fail(message) {
  console.error(`\nFAIL  ${message}`);
  process.exit(1);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

function walk(dir, base = dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, found);
    else found.push(relative(base, full).split(sep).join("/"));
  }
  return found;
}

// ── 1. Build with the CTA and any SDK forced off ─────────────────────────
if (!existsSync(VITE_BIN)) fail("vite is not installed — run `npm install` first.");

console.log("Building the standalone game (GRYND sign-in CTA on, no portal SDK)…\n");

const build = spawnSync(process.execPath, [VITE_BIN, "build", "--config", VITE_CONFIG], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, PORTAL_CTA: "on", PORTAL_CTA_URL: CTA_URL, PORTAL_SDK: "none" },
});

if (build.error) fail(`could not start the build: ${build.error.message}`);
if (build.status !== 0) fail(`the standalone build failed (exit ${build.status}).`);

// ── 2. Prove the build produced a package ────────────────────────────────
const indexPath = join(PACKAGE_DIR, "index.html");
if (!existsSync(indexPath)) fail(`the build produced no ${indexPath}.`);
if (statSync(indexPath).size === 0) fail(`${indexPath} is empty.`);

const builtFiles = walk(PACKAGE_DIR);
const builtSet = new Set(builtFiles);
for (const required of REQUIRED) {
  if (!builtSet.has(required)) fail(`the build is missing ${required}.`);
}
if (!builtFiles.some((name) => /^assets\/.+\.js$/.test(name))) fail("the build has no JS bundle.");
if (!builtFiles.some((name) => /^assets\/.+\.css$/.test(name))) fail("the build has no stylesheet.");
// The tile face is a bundled asset, so a build whose image import broke would
// otherwise ship a board of blank tiles.
if (!builtFiles.some((name) => /^assets\/logo1-.+\.png$/.test(name))) {
  fail("the build is missing the tile-face logo asset.");
}
if (builtFiles.some((name) => name.endsWith(".map"))) fail("the build contains a source map.");

// A relative `base` is what makes the package work under any portal path; an
// absolute reference would break the moment itch serves it from a subfolder.
const html = readFileSync(indexPath, "utf8");
for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (/^(https?:)?\/\//i.test(ref) || ref.startsWith("/")) {
    fail(`index.html references an absolute URL (${ref}); asset paths must stay relative.`);
  }
}

// ── 3. Zip it ────────────────────────────────────────────────────────────
rmSync(OUT_FILE, { force: true });

let archive;
try {
  archive = zipDirectory(PACKAGE_DIR, OUT_FILE);
} catch (error) {
  fail(error.message);
}

// ── 4. Read the archive back and verify what was actually written ────────
let zip;
try {
  zip = readZip(OUT_FILE);
} catch (error) {
  fail(`the archive it just wrote cannot be read back: ${error.message}`);
}

const names = zip.entries.map((entry) => entry.name);

if (names[0] !== "index.html") {
  fail(`index.html is not the first entry of the archive (found "${names[0]}").`);
}
if (!names.includes("index.html")) fail("the archive has no index.html.");

const missing = builtFiles.filter((name) => !names.includes(name));
if (missing.length) fail(`the archive is missing ${missing.join(", ")}.`);
const extra = names.filter((name) => !builtSet.has(name));
if (extra.length) fail(`the archive contains files that are not in the package: ${extra.join(", ")}.`);

for (const entry of zip.entries) {
  const text = /\.(html|js|css)$/i.test(entry.name) ? entry.data.toString("utf8") : "";
  for (const needle of FORBIDDEN) {
    if (text.toLowerCase().includes(needle.toLowerCase())) {
      fail(`${entry.name} contains "${needle}" — this package must not ship it.`);
    }
  }
}

// The CTA must survive the archive, intact: exactly the sign-in destination,
// its label and its question, as an anchor that opens a new tab. It is also the
// only GRYND address the package may contain.
const shipped = zip.entries
  .filter((entry) => /\.(html|js|css)$/i.test(entry.name))
  .map((entry) => entry.data.toString("utf8"))
  .join("\n");

const gryndUrls = [...shipped.matchAll(/https:\/\/[a-z0-9.-]*grynd\.dedyn\.io[^\s"'`)<]*/gi)].map(
  (match) => match[0],
);
const foreign = gryndUrls.filter((url) => url !== CTA_URL);
if (foreign.length) {
  fail(`the package points at a GRYND address other than the sign-in CTA: ${foreign.join(", ")}`);
}

for (const needle of [CTA_URL, CTA_LABEL, CTA_QUESTION]) {
  if (!shipped.includes(needle)) fail(`the package is missing the CTA (${needle}).`);
}
if (!shipped.includes('"_blank"') || !shipped.includes("noopener noreferrer")) {
  fail('the CTA does not open in a new tab with rel="noopener noreferrer".');
}

// ── 5. Summary ───────────────────────────────────────────────────────────
console.log(`\n${relative(ROOT, OUT_FILE).split(sep).join("/")}  ${kb(archive.bytes)}\n`);
for (const entry of zip.entries) {
  console.log(`  ${kb(entry.size).padStart(9)}  ${entry.name}`);
}
console.log(
  `\n${zip.entries.length} file(s). index.html is first, at the archive root.` +
    `\nAll ${REQUIRED.length} required entries present, plus the tile-face logo;` +
    `\nthe GRYND sign-in CTA is the only GRYND address in the package and no SDK,` +
    `\nsource map or other endpoint ships.` +
    `\n\nNext: npm run verify:itch:memory-grid  (validates the ZIP, extracts it, then plays the copy offline)`,
);
