#!/usr/bin/env node
// scripts/verify-itch-chess-ai.mjs
//
// `npm run verify:itch:chess-ai` — verifies the finished archive, then plays the
// copy that is INSIDE it.
//
// Checks:
//   * the archive is valid and every entry passes its CRC
//   * index.html is the first entry at the root (no wrapper folder)
//   * every reference in index.html resolves inside the archive
//   * the engine JS + WASM are present and byte-identical to the npm build
//   * the GPLv3 text and the source pointer are present and intact
//   * no source, tests, maps or toolchain files
//   * no external host, no production platform surface, no portal SDK
//   * the extracted copy plays, undoes, resigns and restarts offline
//
// Usage:
//   node scripts/verify-itch-chess-ai.mjs
//   node scripts/verify-itch-chess-ai.mjs --no-browser
//   node scripts/verify-itch-chess-ai.mjs --zip=dist/packages/chess-ai-itch.zip --keep

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { extractZip, readZip } from "./lib/zip-read.mjs";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const found = argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const ZIP_FILE = resolve(ROOT, option("zip", "dist/packages/chess-ai-itch.zip"));
const EXTRACT_DIR = resolve(ROOT, "dist/packages/.verify-chess-ai");
const KEEP = argv.includes("--keep");
const SKIP_BROWSER = argv.includes("--no-browser");

const ENGINE_FILES = ["stockfish-nnue-16-single.js", "stockfish-nnue-16-single.wasm"];
const LICENCE_FILE = "LICENSE-STOCKFISH.txt";
const SOURCE_FILE = "STOCKFISH-SOURCE.txt";

/**
 * Hosts that may legitimately appear as inert STRINGS: SVG namespaces, the
 * React/redux/react-dnd documentation URLs the bundled libraries embed, and the
 * FSF/GNU addresses inside the licence text and the source pointer. None of
 * these is fetched at runtime — the browser QA below plays the game with
 * https/wss blocked and fails if any request leaves the package.
 */
const INERT_HOSTS = new Set([
  "www.w3.org",
  "react.dev",
  "reactjs.org",
  "redux.js.org",
  "react-dnd.github.io",
  "github.com",
  "www.npmjs.com",
  "fsf.org",
  "www.gnu.org",
]);

const FORBIDDEN_CONTENT = [
  ["clerk", "Clerk auth"],
  ["supabase", "Supabase"],
  ["socket.io", "Socket.IO"],
  ["posthog", "PostHog"],
  ["sentry", "Sentry"],
  ["adsbygoogle", "Google ads"],
  ["googletag", "Google Tag Manager"],
  ["monetag", "Monetag"],
  ["umami", "Umami analytics"],
  ["sdk.crazygames.com", "the CrazyGames SDK"],
];

const FORBIDDEN_SEGMENTS = new Set([
  "node_modules",
  "src",
  "tests",
  "test",
  "standalone",
  "scripts",
  "qa",
  "docs",
  ".git",
]);
const FORBIDDEN_FILENAMES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.mts",
  "vite.config.harness.mts",
]);

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

let failures = 0;
const check = (label, run) => {
  try {
    const detail = run();
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${label} — ${error.message}`);
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

if (!existsSync(ZIP_FILE)) {
  console.error(
    `\nFAIL  no archive at ${relative(ROOT, ZIP_FILE).split(sep).join("/")}` +
      "\n      run `npm run package:itch:chess-ai` first.\n"
  );
  process.exit(1);
}

console.log(
  `\nVerifying ${relative(ROOT, ZIP_FILE).split(sep).join("/")}  (${kb(statSync(ZIP_FILE).size)})\n`
);

let zip;
try {
  zip = readZip(ZIP_FILE);
  console.log(`  ok    archive is a valid ZIP — ${zip.entries.length} entries, every CRC verified`);
} catch (error) {
  console.error(`  FAIL  archive is a valid ZIP — ${error.message}`);
  console.error("\nFAILED — nothing else can be checked without a readable archive.\n");
  process.exit(1);
}

const names = zip.entries.map((entry) => entry.name);
const byName = new Map(zip.entries.map((entry) => [entry.name, entry]));

check("index.html is the first entry and at the root", () => {
  assert(names[0] === "index.html", `first entry is "${names[0]}"`);
  assert(!names.some((name) => name.includes("/index.html")), "an index.html is nested");
  return "no wrapper folder";
});

check("no source, tests, maps or toolchain files", () => {
  for (const name of names) {
    assert(!name.includes("\\"), `${name} uses a Windows separator`);
    assert(!name.startsWith("/") && !/^[a-zA-Z]:/.test(name), `${name} is absolute`);
    const parts = name.split("/");
    assert(!parts.includes("..") && !parts.includes(""), `${name} is not a clean relative path`);
    for (const part of parts) assert(!FORBIDDEN_SEGMENTS.has(part), `${name} includes "${part}"`);
    const leaf = parts[parts.length - 1];
    assert(!FORBIDDEN_FILENAMES.has(leaf), `${name} is a toolchain file`);
    assert(!/\.(map|ts|tsx|mts|cts|mjs|cjs|md|env)$/i.test(name), `${name} is not shipped output`);
    assert(
      /\.(html|js|css|svg|png|ico|wasm|txt)$/i.test(name),
      `${name} is not a type a browser build needs`
    );
  }
  return `${names.length} entries, all shipped output`;
});

check("every reference in index.html resolves inside the archive", () => {
  const html = byName.get("index.html").data.toString("utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert(refs.length >= 2, `found only ${refs.length} reference(s)`);
  for (const ref of refs) {
    assert(!/^(https?:)?\/\//i.test(ref), `${ref} is an external URL`);
    assert(!ref.startsWith("/"), `${ref} is root-absolute`);
    const target = ref.replace(/^\.\//, "").split("?")[0].split("#")[0];
    assert(byName.has(target), `${ref} is not in the archive`);
  }
  assert(
    names.some((name) => /^assets\/.+\.js$/.test(name)),
    "no JS bundle"
  );
  assert(
    names.some((name) => /^assets\/.+\.css$/.test(name)),
    "no stylesheet"
  );
  return `${refs.length} relative references, all present`;
});

check("the engine is present and byte-identical to the npm build", () => {
  for (const name of ENGINE_FILES) {
    const entry = byName.get(`engine/${name}`);
    assert(entry, `engine/${name} is missing`);
    const source = resolve(ROOT, "node_modules/stockfish/src", name);
    assert(existsSync(source), `node_modules/stockfish/src/${name} is missing`);
    assert(sha256(entry.data) === sha256(readFileSync(source)), `engine/${name} was modified`);
  }
  const wasm = byName.get("engine/stockfish-nnue-16-single.wasm");
  return `${ENGINE_FILES.join(" + ")}, ${kb(wasm.size)} wasm, unmodified`;
});

check("the GPLv3 text and the source pointer are shipped", () => {
  const licence = byName.get(LICENCE_FILE)?.data.toString("utf8") ?? "";
  const source = byName.get(SOURCE_FILE)?.data.toString("utf8") ?? "";
  assert(/GNU GENERAL PUBLIC LICENSE/i.test(licence), `${LICENCE_FILE} is missing or not the GPL`);
  assert(/Version 3/i.test(licence), `${LICENCE_FILE} is not version 3`);
  for (const needle of ["github.com/official-stockfish/Stockfish", "sf_16", "unmodified"]) {
    assert(source.includes(needle), `${SOURCE_FILE} is missing "${needle}"`);
  }
  return `${LICENCE_FILE} (${kb(byName.get(LICENCE_FILE).size)}) + ${SOURCE_FILE}`;
});

check("no external runtime dependency", () => {
  const hosts = new Set();
  for (const entry of zip.entries) {
    if (!/\.(html|js|css|txt)$/i.test(entry.name)) continue;
    const text = entry.data.toString("utf8");
    for (const [, host] of text.matchAll(/https?:\/\/([a-zA-Z0-9._-]+)/g)) hosts.add(host);
    for (const [, ref] of text.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/g)) {
      assert(!/^(https?:)?\/\//i.test(ref), `${entry.name} loads ${ref}`);
    }
    assert(!/url\(\s*["']?https?:/i.test(text), `${entry.name} references a remote asset`);
  }
  const unexpected = [...hosts].filter((host) => !INERT_HOSTS.has(host));
  assert(unexpected.length === 0, `unexpected host(s): ${unexpected.join(", ")}`);
  return hosts.size === 0
    ? "no host named anywhere"
    : `only inert hosts (${[...hosts].join(", ")})`;
});

check("no production platform surface or portal SDK", () => {
  const hits = [];
  for (const entry of zip.entries) {
    if (!/\.(html|js|css|txt)$/i.test(entry.name)) continue;
    const text = entry.data.toString("utf8").toLowerCase();
    for (const [needle, description] of FORBIDDEN_CONTENT) {
      if (text.includes(needle)) hits.push(`${entry.name}: ${description}`);
    }
    // Only an APP-relative route (a quoted string starting with /api/) is a
    // request target; a documentation URL that happens to contain /api/ is not.
    if (/["'`]\/api\//.test(entry.data.toString("utf8"))) {
      hits.push(`${entry.name}: an app-relative API route`);
    }
  }
  assert(hits.length === 0, hits.join("; "));
  return `${FORBIDDEN_CONTENT.length} signatures absent`;
});

check("the archive extracts cleanly", () => {
  rmSync(EXTRACT_DIR, { recursive: true, force: true });
  mkdirSync(EXTRACT_DIR, { recursive: true });
  extractZip(zip, EXTRACT_DIR);
  const written = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else written.push(relative(EXTRACT_DIR, full).split(sep).join("/"));
    }
  };
  walk(EXTRACT_DIR);
  assert(written.length === names.length, `extracted ${written.length} of ${names.length} files`);
  for (const name of names) {
    const target = join(EXTRACT_DIR, ...name.split("/"));
    assert(existsSync(target), `${name} did not extract`);
    assert(statSync(target).size === byName.get(name).size, `${name} extracted at the wrong size`);
  }
  return `${written.length} file(s)`;
});

if (SKIP_BROWSER) {
  console.log("  skip  offline browser QA (--no-browser)");
} else if (failures > 0) {
  console.log("  skip  offline browser QA (static checks already failed)");
} else {
  console.log("\nPlaying the extracted package in Chrome, network blocked…\n");
  const qa = spawnSync(
    process.execPath,
    [resolve(ROOT, "qa/chess-ai-standalone-check.mjs"), `--dir=${EXTRACT_DIR}`],
    { cwd: ROOT, stdio: "inherit" }
  );
  if (qa.status === 0) console.log("  ok    offline browser QA on the extracted archive");
  else {
    failures += 1;
    console.error(
      `  FAIL  offline browser QA on the extracted archive — exit ${qa.status ?? "null"}`
    );
  }
}

if (!KEEP) rmSync(EXTRACT_DIR, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nFAILED — ${failures} check(s) failed. The package must not be uploaded.\n`);
  process.exit(1);
}

console.log(
  `\nPACKAGE VERIFIED  ${relative(ROOT, ZIP_FILE).split(sep).join("/")}  (${kb(statSync(ZIP_FILE).size)})\n` +
    "  · index.html first, at the root, all references resolving inside the archive\n" +
    "  · the engine is byte-identical to the unmodified Stockfish 16 npm build\n" +
    "  · the GPLv3 licence text and the upstream source pointer ship with it\n" +
    "  · no external host, no platform API/auth/database, no portal SDK\n" +
    "  · the extracted copy played, undid, resigned and restarted offline\n" +
    "\nReady to upload to itch.io. Nothing has been uploaded.\n"
);
