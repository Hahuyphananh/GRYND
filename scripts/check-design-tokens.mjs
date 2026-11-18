// scripts/check-design-tokens.mjs
//
// Phase 0's drift guard: no NEW arbitrary colour may enter the product tree.
//
// The audit found 3,274 hex literals and 281 distinct colours across the app —
// the reason every screen looked slightly different. The token migration will
// lower those numbers screen by screen; this script makes sure they can never
// go UP while it happens.
//
// How it works: qa/design-token-baseline.json stores, per file, how many hex
// literals a file contained on the day the baseline was taken. A file may keep
// its count or go down. A count that rises, or a new file that carries colour
// at all, fails the check.
//
// Exempt (they legitimately own colour):
//   src/app/globals.css            the token blocks
//   src/app/light-theme.css        generated
//   src/app/solitaire-cosmetics.css
//
// Usage:
//   node scripts/check-design-tokens.mjs                    check (exit 1 on drift)
//   node scripts/check-design-tokens.mjs --update            re-baseline (deliberate)
//   node scripts/check-design-tokens.mjs --root <dir> --baseline <file>
//                                                           scoped run (used by the test)

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep, isAbsolute, resolve } from "node:path";

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const ROOTS = argValue("--root") ? [argValue("--root")] : ["src/app", "src/components"];
const BASELINE = argValue("--baseline", "qa/design-token-baseline.json");
const SOURCE = /\.(jsx?|tsx?|mjs|css)$/;
const EXEMPT = new Set([
  "src/app/globals.css",
  "src/app/light-theme.css",
  "src/app/solitaire-cosmetics.css",
]);

/** #rgb, #rrggbb, #rrggbbaa — the forms an arbitrary colour takes in class strings. */
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

const normalise = (path) => relative(process.cwd(), path).split(sep).join("/");

function walk(dir, out = []) {
  const absolute = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  for (const entry of readdirSync(absolute)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(absolute, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      walk(path, out);
    } else if (SOURCE.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Hex literals in a file, with comments and CSS import URLs left out. */
function countColours(source) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/url\([^)]*\)/g, "");
  return (stripped.match(HEX) ?? []).length;
}

const files = ROOTS.flatMap((root) => walk(root))
  .map(normalise)
  .filter((path) => !EXEMPT.has(path))
  .sort();

const current = {};
for (const path of files) {
  const count = countColours(readFileSync(path, "utf8"));
  if (count > 0) current[path] = count;
}

if (argv.includes("--update")) {
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note: "Per-file count of arbitrary hex colour literals. A file may only go DOWN. Regenerate deliberately with: node scripts/check-design-tokens.mjs --update",
        taken: new Date().toISOString().slice(0, 10),
        files: current,
      },
      null,
      2,
    ) + "\n",
  );
  const total = Object.values(current).reduce((sum, n) => sum + n, 0);
  console.log(
    `baseline written → ${BASELINE} (${Object.keys(current).length} files, ${total} hex literals)`,
  );
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`missing ${BASELINE} — run: node scripts/check-design-tokens.mjs --update`);
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8")).files ?? {};
const problems = [];

for (const [path, count] of Object.entries(current)) {
  const allowed = baseline[path];
  if (allowed === undefined) {
    problems.push(
      `${path}: new file with ${count} arbitrary colour(s) — use a token from src/app/globals.css`,
    );
  } else if (count > allowed) {
    problems.push(`${path}: ${count} arbitrary colours, baseline is ${allowed} (+${count - allowed})`);
  }
}

const removed = Object.keys(baseline).filter((path) => current[path] === undefined);
const totalNow = Object.values(current).reduce((sum, n) => sum + n, 0);
const totalBefore = Object.values(baseline).reduce((sum, n) => sum + n, 0);

if (problems.length > 0) {
  console.error("design-token guard: arbitrary colours increased\n");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(
    `\n  total ${totalBefore} → ${totalNow}\n` +
      "  Fix: use a semantic token (--bg-*, --text-*, --accent, --state-*, --border-*)\n" +
      "  in src/app/globals.css. Re-baselining to accept a new hex defeats the guard.\n",
  );
  process.exit(1);
}

console.log(
  `design-token guard: ok — ${totalNow} arbitrary colours in ${Object.keys(current).length} files ` +
    `(baseline ${totalBefore}${removed.length ? `, ${removed.length} file(s) now clean` : ""})`,
);
