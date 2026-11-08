#!/usr/bin/env node
// scripts/verify-itch-memory-grid.mjs
//
// `npm run verify:itch:memory-grid` — verifies the finished archive, then plays
// what is INSIDE it.
//
// Everything here is done against `dist/packages/memory-grid-itch.zip`: parsed
// out of its central directory (every entry's CRC and length checked), inspected
// as a portal would receive it, extracted to a scratch folder, and finally driven
// in a real Chrome with the network blocked. A package that passes this is the
// package that was tested — not the Vite output it came from.
//
// Checks:
//   * the archive is valid and every entry passes its CRC
//   * index.html is the first entry and sits at the root (no wrapper folder)
//   * every JS/CSS/image reference in index.html resolves inside the archive
//   * the tile-face logo is in the archive AND referenced by the bundle
//   * the archive holds exactly shipped output — no source, tests, maps, configs
//   * no runtime external dependency: every host named anywhere is inert
//     (w3.org SVG namespaces, React's error docs) — no CDN, font, tracker or API
//   * no GRYND API/auth/database/Oracle/Socket.IO/advertising surface
//   * the GRYND sign-in CTA present and intact, and the only GRYND address in
//     the package (use --no-cta to verify a CTA-free build instead)
//   * no portal SDK
//   * the extracted copy loads, starts a match, memorises, reconstructs,
//     submits and shows the round result offline
//
// Usage:
//   node scripts/verify-itch-memory-grid.mjs
//   node scripts/verify-itch-memory-grid.mjs --zip=dist/packages/memory-grid-itch.zip --keep
//   node scripts/verify-itch-memory-grid.mjs --no-browser     # static checks only
//   node scripts/verify-itch-memory-grid.mjs --no-cta         # a build without the CTA

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { extractZip, readZip } from "./lib/zip-read.mjs";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const found = argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const ZIP_FILE = resolve(ROOT, option("zip", "dist/packages/memory-grid-itch.zip"));
const EXTRACT_DIR = resolve(ROOT, "dist/packages/.verify-extract");
const KEEP = argv.includes("--keep");
const SKIP_BROWSER = argv.includes("--no-browser");

/**
 * The CTA the itch package is built with (`scripts/package-itch-memory-grid.mjs`).
 * The destination is the production sign-in route
 * (`src/app/sign-in/[[...sign-in]]`, allow-listed in `src/proxy.ts`).
 */
const CTA_URL = "https://www.grynd.dedyn.io/sign-in";
const CTA_LABEL = "Sign in to GRYND";
const CTA_QUESTION = "Want to track your stats and compete in ranked games?";
const CTA_HOST = new URL(CTA_URL).host;
/** A default (non-itch) package has the CTA compiled out; `--no-cta` checks that. */
const EXPECT_CTA = !argv.includes("--no-cta");

/** Hosts that may legitimately appear as inert strings in a bundled build. */
const INERT_HOSTS = new Set(["www.w3.org", "react.dev"]);

/** The only other host a package may name: the CTA's own destination. */
const ALLOWED_HOSTS = new Set([...INERT_HOSTS, ...(EXPECT_CTA ? [CTA_HOST] : [])]);

/** Path segments and filenames that must never reach a portal. */
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
  ".freebuff",
  ".agents",
]);
const FORBIDDEN_FILENAMES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.mts",
  "postcss.config.cjs",
  "tailwind.config.cjs",
]);

/** Production surface that has no business in a standalone game. */
const FORBIDDEN_CONTENT = [
  ["/api/", "a GRYND API route"],
  ["clerk", "Clerk auth"],
  ["supabase", "Supabase"],
  ["oracle", "Oracle"],
  ["socket.io", "Socket.IO"],
  ["posthog", "PostHog"],
  ["sentry", "Sentry"],
  ["adsbygoogle", "Google ads"],
  ["googletag", "Google Tag Manager"],
  ["monetag", "Monetag"],
  ["umami", "Umami analytics"],
  ["sdk.crazygames.com", "the CrazyGames SDK"],
];

/** Any GRYND address in the archive. Only the CTA's sign-in URL may appear. */
const GRYND_URL = /https:\/\/[a-z0-9.-]*grynd\.dedyn\.io[^\s"'`)<]*/gi;

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
const isText = (name) => /\.(html|js|css|svg|webmanifest|txt)$/i.test(name);

let failures = 0;

function ok(label, detail) {
  console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
}

function bad(label, detail) {
  failures += 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

function check(label, run) {
  try {
    const detail = run();
    ok(label, detail);
  } catch (error) {
    bad(label, error.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

if (!existsSync(ZIP_FILE)) {
  console.error(
    `\nFAIL  no archive at ${relative(ROOT, ZIP_FILE).split(sep).join("/")}` +
      "\n      run `npm run package:itch:memory-grid` first.\n",
  );
  process.exit(1);
}

console.log(
  `\nVerifying ${relative(ROOT, ZIP_FILE).split(sep).join("/")}  (${kb(statSync(ZIP_FILE).size)})\n`,
);

// ── 1. The archive itself ────────────────────────────────────────────────
let zip;
try {
  zip = readZip(ZIP_FILE);
  ok("archive is a valid ZIP", `${zip.entries.length} entries, every CRC verified`);
} catch (error) {
  bad("archive is a valid ZIP", error.message);
  console.error("\nFAILED — nothing else can be checked without a readable archive.");
  process.exit(1);
}

const names = zip.entries.map((entry) => entry.name);
const byName = new Map(zip.entries.map((entry) => [entry.name, entry]));

check("index.html is the first entry and at the root", () => {
  assert(names[0] === "index.html", `first entry is "${names[0]}"`);
  assert(!names.some((name) => name.includes("/index.html")), "an index.html is nested in a folder");
  return "no wrapper folder";
});

check("no source, tests, maps or toolchain files", () => {
  for (const name of names) {
    assert(!name.includes("\\"), `${name} uses a Windows path separator`);
    assert(!name.startsWith("/") && !/^[a-zA-Z]:/.test(name), `${name} is an absolute path`);
    const parts = name.split("/");
    assert(!parts.includes("..") && !parts.includes(""), `${name} is not a clean relative path`);
    for (const part of parts) {
      assert(!FORBIDDEN_SEGMENTS.has(part), `${name} includes the dev folder "${part}"`);
    }
    const leaf = parts[parts.length - 1];
    assert(!FORBIDDEN_FILENAMES.has(leaf), `${name} is a toolchain file`);
    assert(!/\.(map|ts|tsx|mts|cts|mjs|cjs|md|env)$/i.test(name), `${name} is not shipped output`);
    assert(
      /\.(html|js|css|png|svg|ico|webmanifest|txt)$/i.test(name),
      `${name} is not a type a browser build needs`,
    );
  }
  return `${names.length} entries, all shipped output`;
});

// ── 2. References inside index.html ──────────────────────────────────────
check("every reference in index.html resolves inside the archive", () => {
  const html = byName.get("index.html").data.toString("utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert(refs.length >= 3, `found only ${refs.length} reference(s)`);

  const resolved = [];
  for (const ref of refs) {
    assert(!/^(https?:)?\/\//i.test(ref), `${ref} is an external URL`);
    assert(!ref.startsWith("/"), `${ref} is root-absolute, not relative to the document`);
    const target = ref.replace(/^\.\//, "").split("?")[0].split("#")[0];
    assert(byName.has(target), `${ref} is not in the archive`);
    resolved.push(target);
  }

  const scripts = names.filter((name) => /^assets\/.*\.js$/.test(name));
  assert(scripts.length === 1, `expected 1 JS bundle, found ${scripts.length}`);
  assert(resolved.includes(scripts[0]), `${scripts[0]} is not loaded by index.html`);
  const styles = names.filter((name) => /^assets\/.*\.css$/.test(name));
  assert(styles.length === 1, `expected 1 stylesheet, found ${styles.length}`);
  assert(resolved.includes(styles[0]), `${styles[0]} is not loaded by index.html`);
  assert(names.includes("favicon.svg"), "the favicon is missing");
  return `${refs.length} relative references, all present`;
});

check("the tile-face logo is shipped and referenced by the bundle", () => {
  const logo = names.find((name) => /^assets\/logo1-.*\.png$/.test(name));
  assert(logo, "no assets/logo1-*.png in the archive");
  const script = names.find((name) => /^assets\/.*\.js$/.test(name));
  const bundle = byName.get(script).data.toString("utf8");
  // Vite rewrites the `new URL(..., import.meta.url)` asset reference to the
  // hashed name; if that rewrite vanished, every tile would face a broken image.
  assert(bundle.includes(logo.split("/").pop()), `${logo} is never referenced by ${script}`);
  assert(byName.get(logo).size > 1024, `${logo} looks empty (${byName.get(logo).size} B)`);
  return `${logo} (${kb(byName.get(logo).size)}), referenced from the bundle`;
});

// ── 3. No external runtime dependency ────────────────────────────────────
check("no external runtime dependency", () => {
  const hosts = new Set();
  for (const entry of zip.entries) {
    if (!isText(entry.name)) continue;
    const text = entry.data.toString("utf8");
    for (const [, host] of text.matchAll(/https?:\/\/([a-zA-Z0-9._-]+)/g)) hosts.add(host);
    for (const [, ref] of text.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/g)) {
      assert(!/^(https?:)?\/\//i.test(ref), `${entry.name} loads ${ref}`);
    }
    assert(!/@import\s+(?:url\()?["']?https?:/i.test(text), `${entry.name} imports a remote stylesheet`);
    assert(!/url\(\s*["']?https?:/i.test(text), `${entry.name} references a remote asset`);
  }
  const unexpected = [...hosts].filter((host) => !ALLOWED_HOSTS.has(host));
  assert(unexpected.length === 0, `unexpected host(s): ${unexpected.join(", ")}`);
  return `${hosts.size} host(s), all inert or the CTA destination (${[...hosts].join(", ")})`;
});

check("it can only talk to its own origin at runtime", () => {
  for (const entry of zip.entries) {
    if (!/\.js$/i.test(entry.name)) continue;
    const text = entry.data.toString("utf8");
    for (const [, url] of text.matchAll(/["'`](https?:\/\/[^"'`]+)["'`]/g)) {
      if (EXPECT_CTA && url === CTA_URL) continue;
      const host = url.replace(/^https?:\/\//, "").split("/")[0];
      assert(INERT_HOSTS.has(host), `${entry.name} contains the URL literal ${url}`);
    }
  }
  return EXPECT_CTA
    ? "no external URL literals except the CTA anchor"
    : "no external URL literals, no fetch target";
});

// ── 4. No GRYND production surface ───────────────────────────────────────
check("no GRYND API, auth, database, Oracle, Socket.IO or ad scripts", () => {
  const hits = [];
  for (const entry of zip.entries) {
    if (!isText(entry.name)) continue;
    const text = entry.data.toString("utf8").toLowerCase();
    for (const [needle, description] of FORBIDDEN_CONTENT) {
      if (text.includes(needle.toLowerCase())) hits.push(`${entry.name}: ${description}`);
    }
  }
  assert(hits.length === 0, hits.join("; "));
  return `${FORBIDDEN_CONTENT.length} signatures absent from ${zip.entries.length} entries`;
});

check(EXPECT_CTA ? "the GRYND CTA is present, intact and inert" : "the GRYND CTA is absent", () => {
  const texts = zip.entries
    .filter((entry) => isText(entry.name))
    .map((entry) => entry.data.toString("utf8"));
  const urls = [...texts.join("\n").matchAll(GRYND_URL)].map((match) => match[0]);
  const bundle = zip.entries
    .filter((entry) => /\.js$/i.test(entry.name))
    .map((entry) => entry.data.toString("utf8"))
    .join("\n");

  if (!EXPECT_CTA) {
    assert(!bundle.includes(CTA_LABEL), "the archive contains the CTA button label");
    assert(!bundle.includes(CTA_QUESTION), "the archive contains the CTA question");
    assert(urls.length === 0, `the archive contains a GRYND address (${urls[0]})`);
    return "no CTA copy, no GRYND address";
  }

  for (const required of [CTA_URL, CTA_LABEL, CTA_QUESTION]) {
    assert(bundle.includes(required), `the bundle is missing "${required}"`);
  }
  assert(bundle.includes('"_blank"'), "the CTA does not open in a new tab");
  assert(bundle.includes("noopener noreferrer"), "the CTA has no rel=noopener noreferrer");
  const foreign = urls.filter((url) => url !== CTA_URL);
  assert(foreign.length === 0, `a GRYND address other than the CTA: ${foreign.join(", ")}`);
  return "sign-in CTA with target=_blank + noopener noreferrer, and the only GRYND address";
});

// ── 5. Play the extracted copy, offline ──────────────────────────────────
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
  return `${written.length} file(s) at ${relative(ROOT, EXTRACT_DIR).split(sep).join("/")}`;
});

let browserOk = true;
if (SKIP_BROWSER) {
  console.log("  skip  offline browser QA (--no-browser)");
} else if (failures > 0) {
  browserOk = false;
  console.log("  skip  offline browser QA (static checks already failed)");
} else {
  console.log("\nPlaying the extracted package in Chrome, network blocked…\n");
  const qaArgs = [resolve(ROOT, "qa/memory-grid-standalone-check.mjs"), `--dir=${EXTRACT_DIR}`];
  // The itch package is the one build with the CTA on, so the browser QA must
  // demand it here rather than merely tolerate its absence.
  if (EXPECT_CTA) qaArgs.push("--expect-cta");
  const qa = spawnSync(process.execPath, qaArgs, { cwd: ROOT, stdio: "inherit" });
  if (qa.status === 0) ok("offline browser QA on the extracted archive");
  else {
    browserOk = false;
    bad("offline browser QA on the extracted archive", `exit ${qa.status ?? "null"}`);
  }
}

if (!KEEP) rmSync(EXTRACT_DIR, { recursive: true, force: true });

// ── Result ───────────────────────────────────────────────────────────────
if (failures > 0 || !browserOk) {
  console.error(`\nFAILED — ${failures} check(s) failed. The package must not be uploaded.\n`);
  process.exit(1);
}

console.log(
  `\nPACKAGE VERIFIED  ${relative(ROOT, ZIP_FILE).split(sep).join("/")}  (${kb(statSync(ZIP_FILE).size)})\n` +
    "  · index.html first, at the root, all references resolving inside the archive\n" +
    "  · shipped output only: no source, tests, maps, configs or wrapper folder\n" +
    "  · the tile-face logo is the bundled asset the bundle actually references\n" +
    "  · no external host, no GRYND API/auth/database/Oracle/Socket.IO/ads, no SDK\n" +
    (EXPECT_CTA
      ? "  · the GRYND sign-in CTA is intact and is the only GRYND address in the package\n"
      : "  · the GRYND CTA is compiled out: no copy, no address\n") +
    "  · the extracted copy played a full match to its final screen with the network\n" +
    (EXPECT_CTA
      ? "    blocked, checked the CTA there, and replayed afterwards\n"
      : "    blocked, with no CTA shipped, and replayed afterwards\n") +
    "\nReady to upload to itch.io. Nothing has been uploaded.\n",
);
