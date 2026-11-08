#!/usr/bin/env node
// scripts/package-itch-chess-ai.mjs
//
// `npm run package:itch:chess-ai` — the itch.io deliverable, in one command.
//
//   1. builds the standalone game with Vite (relative paths, engine beside it),
//   2. refuses to continue unless the build, the engine and the LICENCE files are
//      all present, and the shipped engine is byte-identical to the npm build,
//   3. zips it with index.html at the archive root,
//   4. reads the archive back and proves its contents before printing a summary.
//
// THE LICENCE IS PART OF THE GAME, not an afterthought: Stockfish is GPLv3, so
// the archive must contain the full licence text and a source pointer, and the
// engine files must be the unmodified upstream build.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { readZip } from "./lib/zip-read.mjs";
import { zipDirectory } from "./zip-portal-package.mjs";

const ROOT = process.cwd();
const PACKAGE_DIR = resolve(ROOT, "dist/portal/chess-ai");
const OUT_FILE = resolve(ROOT, "dist/packages/chess-ai-itch.zip");
const VITE_BIN = resolve(ROOT, "node_modules/vite/bin/vite.js");
const VITE_CONFIG = resolve(ROOT, "standalone/chess-ai/vite.config.mts");

const ENGINE_FILES = ["stockfish-nnue-16-single.js", "stockfish-nnue-16-single.wasm"];
const LICENCE_FILE = "LICENSE-STOCKFISH.txt";
const SOURCE_FILE = "STOCKFISH-SOURCE.txt";

const REQUIRED = [
  "index.html",
  LICENCE_FILE,
  SOURCE_FILE,
  ...ENGINE_FILES.map((name) => `engine/${name}`),
];

/** A portal package must not contain the production platform or any SDK. */
const FORBIDDEN = [
  "clerk",
  "supabase",
  "socket.io",
  "posthog",
  "sentry",
  "adsbygoogle",
  "googletag",
  "monetag",
  "umami",
  "sdk.crazygames.com",
  "grynd.dedyn.io",
];

function fail(message) {
  console.error(`\nFAIL  ${message}`);
  process.exit(1);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function walk(dir, base = dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, found);
    else found.push(relative(base, full).split(sep).join("/"));
  }
  return found;
}

// ── 1. Build ─────────────────────────────────────────────────────────────
if (!existsSync(VITE_BIN)) fail("vite is not installed — run `npm install` first.");

console.log("Building the standalone chess game…\n");
const build = spawnSync(process.execPath, [VITE_BIN, "build", "--config", VITE_CONFIG], {
  cwd: ROOT,
  stdio: "inherit",
});

if (build.error) fail(`could not start the build: ${build.error.message}`);
if (build.status !== 0) fail(`the standalone build failed (exit ${build.status}).`);

// ── 2. The build must be complete ────────────────────────────────────────
const indexPath = join(PACKAGE_DIR, "index.html");
if (!existsSync(indexPath) || statSync(indexPath).size === 0)
  fail(`the build produced no index.html.`);

const builtFiles = walk(PACKAGE_DIR);
const builtSet = new Set(builtFiles);
for (const required of REQUIRED) {
  if (!builtSet.has(required)) fail(`the build is missing ${required}.`);
}
if (!builtFiles.some((name) => /^assets\/.+\.js$/.test(name))) fail("the build has no JS bundle.");
if (!builtFiles.some((name) => /^assets\/.+\.css$/.test(name)))
  fail("the build has no stylesheet.");
if (builtFiles.some((name) => name.endsWith(".map"))) fail("the build contains a source map.");

// The deployed engine must be exactly the one the licence describes.
for (const name of ENGINE_FILES) {
  const built = join(PACKAGE_DIR, "engine", name);
  const source = resolve(ROOT, "node_modules/stockfish/src", name);
  if (!existsSync(source)) fail(`the npm engine build is missing ${name}.`);
  if (sha256(built) !== sha256(source)) {
    fail(`engine/${name} is not byte-identical to node_modules/stockfish/src/${name}.`);
  }
  if (statSync(built).size < (name.endsWith(".wasm") ? 100_000 : 1_000)) {
    fail(`engine/${name} looks empty.`);
  }
}

// The licence must actually be the GPL, and the pointer must name the source.
const licence = readFileSync(join(PACKAGE_DIR, LICENCE_FILE), "utf8");
if (!/GNU GENERAL PUBLIC LICENSE/i.test(licence) || !/Version 3/i.test(licence)) {
  fail(`${LICENCE_FILE} does not look like the GPLv3 text.`);
}
const source = readFileSync(join(PACKAGE_DIR, SOURCE_FILE), "utf8");
for (const needle of [
  "Stockfish",
  "github.com/official-stockfish/Stockfish",
  "sf_16",
  "unmodified",
  "LICENSE-STOCKFISH.txt",
]) {
  if (!source.includes(needle)) fail(`${SOURCE_FILE} is missing "${needle}".`);
}

// A relative `base` is what makes the package work under any portal path.
const html = readFileSync(indexPath, "utf8");
for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (/^(https?:)?\/\//i.test(ref) || ref.startsWith("/")) {
    fail(`index.html references an absolute URL (${ref}); asset paths must stay relative.`);
  }
}

// ── 3. Zip ───────────────────────────────────────────────────────────────
rmSync(OUT_FILE, { force: true });
let archive;
try {
  archive = zipDirectory(PACKAGE_DIR, OUT_FILE);
} catch (error) {
  fail(error.message);
}

// ── 4. Read the archive back and verify what was written ─────────────────
let zip;
try {
  zip = readZip(OUT_FILE);
} catch (error) {
  fail(`the archive it just wrote cannot be read back: ${error.message}`);
}

const names = zip.entries.map((entry) => entry.name);
if (names[0] !== "index.html") fail(`index.html is not the first entry (found "${names[0]}").`);

const missing = builtFiles.filter((name) => !names.includes(name));
if (missing.length) fail(`the archive is missing ${missing.join(", ")}.`);
const extra = names.filter((name) => !builtSet.has(name));
if (extra.length)
  fail(`the archive contains files that are not in the package: ${extra.join(", ")}.`);

for (const entry of zip.entries) {
  if (!/\.(html|js|css|txt)$/i.test(entry.name)) continue;
  const text = entry.data.toString("utf8");
  for (const needle of FORBIDDEN) {
    if (text.toLowerCase().includes(needle.toLowerCase())) {
      fail(`${entry.name} contains "${needle}" — this package must not ship it.`);
    }
  }
  // An APP-relative route starts a quoted string (`"/api/..."`), which is what
  // a fetch or an anchor would carry. A doc URL such as
  // `https://redux.js.org/api/...` is an inert string and is not this pattern.
  if (/["'`]\/api\//.test(text)) {
    fail(`${entry.name} contains an app-relative /api/ path — this package must not ship it.`);
  }
}

// The licence has to survive the zip byte-for-byte, not just be present.
for (const name of [LICENCE_FILE, SOURCE_FILE]) {
  const entry = zip.entries.find((candidate) => candidate.name === name);
  if (!entry) fail(`the archive has no ${name}.`);
  if (!entry.data.equals(readFileSync(join(PACKAGE_DIR, name)))) {
    fail(`${name} did not survive the archive intact.`);
  }
}

console.log(`\n${relative(ROOT, OUT_FILE).split(sep).join("/")}  ${kb(archive.bytes)}\n`);
for (const entry of zip.entries) {
  console.log(`  ${kb(entry.size).padStart(9)}  ${entry.name}`);
}
console.log(
  `\n${zip.entries.length} file(s). index.html is first, at the archive root.` +
    `\nThe engine is byte-identical to the npm Stockfish 16 build, and the archive` +
    `\ncarries the GPLv3 text plus the source pointer.` +
    `\n\nNext: npm run verify:itch:chess-ai  (validates the ZIP, extracts it, then plays that copy offline)`
);
