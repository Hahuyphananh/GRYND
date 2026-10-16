// Guards the @tabler/icons-react usage in src/:
//   1. Every imported icon name must exist in the installed package
//      (catches typos like IconMoodAsleep — which typecheck misses because
//      the package's types are loose, but the bundler fails on).
//   2. Reports imported-but-unused icons so dead imports get cleaned up.
// Exits non-zero if any imported icon is invalid, so it can run in CI.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// ── 1. Collect the icon names exported by the installed package ─────────
const distBase = path.join(root, "node_modules", "@tabler", "icons-react", "dist");
const dtsFile = fs.readdirSync(distBase).find((n) => n.endsWith(".d.ts"));
if (!dtsFile) {
  console.error("✗ Could not find @tabler/icons-react type declarations. Run `npm install`.");
  process.exit(1);
}
const dts = fs.readFileSync(path.join(distBase, dtsFile), "utf8");
const exported = new Set();
for (const m of dts.matchAll(/declare\s+const\s+(Icon[A-Za-z0-9_]+)\s*:/g)) {
  exported.add(m[1]);
}

// ── 2. Scan src/ for real imports of @tabler/icons-react ────────────────
const importRe = /import\s*\{([^}]*)\}\s*from\s*["']@tabler\/icons-react["']/g;
const iconNameRe = /Icon[A-Z][A-Za-z0-9]*/g;

const srcFiles = [];
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(js|jsx|ts|tsx)$/.test(f)) srcFiles.push(p);
  }
}
walk(path.join(root, "src"));

const imported = new Map(); // iconName -> { file, count } (count = usages after import)
for (const file of srcFiles) {
  const s = fs.readFileSync(file, "utf8");
  importRe.lastIndex = 0;
  let m;
  while ((m = importRe.exec(s))) {
    for (const name of m[1].match(iconNameRe) || []) {
      const usage = s.split(name).length - 1; // 1 = only the import itself
      const prev = imported.get(name);
      if (!prev || usage > prev.count) {
        imported.set(name, { file: file.slice(root.length + 1), count: usage });
      }
    }
  }
}

// ── 3. Validate ─────────────────────────────────────────────────────────
const invalid = [];
const unused = [];
for (const [name, info] of imported) {
  if (!exported.has(name)) invalid.push({ name, file: info.file });
  else if (info.count <= 1) unused.push({ name, file: info.file });
}

console.log(`Checked ${imported.size} imported icons against ${exported.size} exports.`);

let failed = false;
if (invalid.length) {
  failed = true;
  console.error(`\n✗ ${invalid.length} imported icon(s) do NOT exist in @tabler/icons-react:`);
  for (const { name, file } of invalid) console.error(`   ${name}  (${file})`);
  console.error(`   Fix the import (rename to a valid icon) or run \`npm install\` to bump the package.`);
}
if (unused.length) {
  console.warn(`\n⚠ ${unused.length} imported icon(s) are never used:`);
  for (const { name, file } of unused) console.warn(`   ${name}  (${file})`);
  console.warn(`   Remove them from the import statement.`);
}

if (invalid.length) {
  console.error("\n✗ Icon check FAILED.");
  process.exit(1);
}
console.log("✓ All imported icons exist.");
process.exit(0);
