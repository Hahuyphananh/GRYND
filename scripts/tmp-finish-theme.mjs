/**
 * One-off: finish the light-theme removal.
 *
 * 1. Replaces the 19 family-tinted ground utilities the neutral migration could
 *    not express, with per-utility tint vars (dark default = the utility's own
 *    colour, so dark mode is unchanged; light override = the generated target).
 * 2. Replaces the last 4 neutral utilities the class-boundary rule skipped.
 * 3. Rewrites the seven bespoke CSS surfaces to var() grounds.
 * 4. Moves the light `--gr-surface-*` block into globals.css.
 * 5. Deletes light-theme.css + the generator, drops the @import and npm script.
 * 6. Retargets game-visual-tokens, the game-primitives qa harness, and stale comments.
 */
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8").split("\r\n").join("\n");
const write = (p, s) => fs.writeFileSync(p, s);
const css = read("src/app/light-theme.css");

const ROLE = { "#24417f": "page", "#31508f": "surface", "#1b3266": "panel" };
const PREFIXES = ["ring-offset-", "bg-", "from-", "via-", "to-"];
const BOUNDARY_BEFORE = new Set([" ", "\t", "\n", "\r", '"', "'", "`", "(", "{", "[", ":"]);
const BOUNDARY_AFTER = new Set([" ", "\t", "\n", "\r", '"', "'", "`", ")", "}", "]", "/", ",", "$"]);

// ── parse the generated rules ───────────────────────────────────────────────
const rules = [...css.matchAll(/(html\[data-theme="light"\][^{]*)\{([^}]*)\}/g)];
const neutral = new Map(); // utility -> token class
const tints = new Map(); // utility -> { name, dark, light }
let i = 0;
for (const [, selector, body] of rules) {
  const hex = (body.match(/#[0-9a-fA-F]{6}/) ?? [])[0]?.toLowerCase();
  if (!hex) continue;
  const classes = [...selector.matchAll(/\.((?:[^\\\s.{:,>+]|\\.)+)/g)]
    .map((m) => m[1].replace(/\\(.)/g, "$1"));
  for (const cls of classes) {
    const prefix = PREFIXES.find((p) => cls.startsWith(p));
    if (!prefix || cls.includes("gr-surface")) continue;
    if (ROLE[hex]) { neutral.set(cls, prefix + ROLE[hex]); continue; }
    const bracket = cls.indexOf("[#");
    if (bracket < 0) continue;
    const dark = cls.slice(bracket + 2, cls.indexOf("]", bracket));
    if (!/^[0-9a-f]{6}$/i.test(dark)) continue;
    const name = "tint-" + cls.slice(0, bracket).replace(/[^a-z0-9]+/gi, "-") + "-" + dark.toLowerCase();
    tints.set(cls, { name, dark: "#" + dark.toLowerCase(), light: hex });
  }
}
console.log("neutral:", neutral.size, "| family tints:", tints.size);
if (neutral.size === 0 || tints.size === 0) throw new Error("parse produced an empty migration");

// ── append the token layer to globals.css ──────────────────────────────────
let globals = read("src/app/globals.css");
const rootBlock = [":root {"];
for (const { name, dark } of tints.values()) rootBlock.push(`  --${name}: ${dark};`);
rootBlock.push("}");
const lightBlock = [
  "/* Light mode re-points ONLY the grounds: the dark theme's own blue, lifted,",
  "   so the authored light ink and neon accents still read. Moved here when the",
  "   generated utility-remap sheet was retired. */",
  'html[data-theme="light"] {',
  "  --gr-surface-page: #24417f;",
  "  --gr-surface-page-rgb: 36 65 127;",
  "  --gr-surface-raised: #31508f;",
  "  --gr-surface-raised-rgb: 49 80 143;",
  "  --gr-surface-panel: #1b3266;",
  "  --gr-surface-panel-rgb: 27 50 102;",
];
for (const { name, light } of tints.values()) lightBlock.push(`  --${name}: ${light};`);
lightBlock.push("}");
globals = globals.replace(
  '@import "./light-theme.css";\n',
  "/* Grounds are semantic tokens (--bg-page/surface/panel) that flip on",
  '   html[data-theme="light"]; there is no generated utility-remap sheet. */\n',
);
globals = globals.trimEnd() + "\n\n" + rootBlock.join("\n") + "\n\n" + lightBlock.join("\n") + "\n";

// ── bespoke surfaces ───────────────────────────────────────────────────────
const bespoke = [
  ["background: linear-gradient(270deg, #030817, #071536, #003b8e, #050b1f);",
   "background: linear-gradient(270deg, var(--bg-page), var(--bg-panel), var(--bg-surface), var(--bg-page));"],
  ["linear-gradient(to bottom, #050714, #02040a);", "linear-gradient(to bottom, var(--bg-surface), var(--bg-page));"],
  ["background: rgba(3, 19, 43, 0.72);", "background: rgba(var(--gr-surface-raised-rgb), 0.72);"],
  ["background-color: rgba(21, 48, 102, 0.62);", "background-color: rgba(var(--gr-surface-raised-rgb), 0.62);"],
  ["linear-gradient(180deg, #061530 0%, #030d22 58%, #01060f 100%);",
   "linear-gradient(180deg, var(--bg-surface) 0%, var(--bg-page) 58%, var(--bg-panel) 100%);"],
  ["radial-gradient(circle at 50% 46%, #04142b 0 44%, #020914 74%, #010409 100%);",
   "radial-gradient(circle at 50% 46%, var(--bg-page) 0 44%, var(--bg-panel) 74%, var(--bg-panel) 100%);"],
  ["linear-gradient(180deg, rgba(3, 19, 43, .82), rgba(2, 8, 22, .88));",
   "linear-gradient(180deg, var(--bg-surface), var(--bg-panel));"],
];
let bespokeHits = 0;
for (const [from, to] of bespoke) {
  if (globals.includes(from)) { globals = globals.split(from).join(to); bespokeHits++; }
}
console.log("bespoke surfaces rewritten:", bespokeHits + "/7");
write("src/app/globals.css", globals);

// ── source utilities ───────────────────────────────────────────────────────
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = dir + "/" + e.name;
  return e.isDirectory() ? walk(p) : /\.(jsx?|tsx?)$/.test(e.name) ? [p] : [];
});

function rewrite(source, map) {
  let out = "", i = 0, hits = 0;
  while (i < source.length) {
    let hit = null;
    for (const [from, to] of map) {
      if (!source.startsWith(from, i)) continue;
      const before = i === 0 ? " " : source[i - 1];
      const after = source[i + from.length] ?? " ";
      if (!BOUNDARY_BEFORE.has(before) || !BOUNDARY_AFTER.has(after)) continue;
      hit = [from, to];
      break;
    }
    if (hit) { out += hit[1]; i += hit[0].length; hits++; } else { out += source[i]; i++; }
  }
  return [out, hits];
}

const tintMap = new Map([...tints].map(([cls, t]) => [cls, cls.slice(0, cls.indexOf("[#")) + "[var(--" + t.name + ")]"]));
const neutralMap = new Map([...neutral].map(([cls, to]) => [cls, to]));
let files = 0, tintHits = 0, neutralHits = 0;
for (const file of [...walk("src/app"), ...walk("src/components")]) {
  let src = read(file);
  let a, b;
  [src, a] = rewrite(src, neutralMap);
  [src, b] = rewrite(src, tintMap);
  if (a + b) { files++; tintHits += b; neutralHits += a; write(file, src); }
}
console.log(`leftovers migrated: neutral=${neutralHits}, tint=${tintHits}, files=${files}`);

// ── retire the generated sheet ────────────────────────────────────────────
fs.rmSync("src/app/light-theme.css");
fs.rmSync("scripts/generate-light-theme.mjs");
const pkg = read("package.json").replace(/^\s*"theme:light": .*\n/m, "");
write("package.json", pkg);
console.log("deleted light-theme.css + generator, removed theme:light");

// ── retarget the suites / harness / stale comments ────────────────────────
let gvt = read("tests/game-visual-tokens.test.mjs");
gvt = gvt.replace(/const THEME_CSS = read\("[^"]+"\);/, "const THEME_CSS = read(\"src/app/globals.css\");");
gvt = gvt.replace(
  /assert\.match\(GLOBALS, \/@import "@;?/,
  "",
);
gvt = gvt.replace(
  'assert.match(GLOBALS, /@import "\\.\\/light-theme\\.css"/);',
  'assert.ok(!GLOBALS.includes("light-theme.css"), "the generated remap sheet is retired");',
);
write("tests/game-visual-tokens.test.mjs", gvt);

let qa = read("qa/game-primitives-check.mjs");
qa = qa.replace(
  /\/\/ Next inlines `@import "\.\/light-theme\.css"`, so the check does too: this is the\n\/\/ only way the light-mode measurements below mean anything\.\nconst lightTheme = readFileSync\(join\(root, "src\/app\/light-theme\.css"\), "utf8"\);\nconst globals = readFileSync\(join\(root, "src\/app\/globals\.css"\), "utf8"\)\n  \.replace\(\/@import\\s\+"\\\.\\\/light-theme\\\.css";\?\/, lightTheme\)\n/,
  "// The ground tokens flip on html[data-theme=\"light\"] in globals.css itself.\nconst globals = readFileSync(join(root, \"src/app/globals.css\"), \"utf8\")\n",
);
write("qa/game-primitives-check.mjs", qa);

for (const file of ["src/context/ThemeContext.js", "src/components/SplashScreen.tsx"]) {
  let s = read(file);
  s = s.split("src/app/light-theme.css (generated — see scripts/generate-light-theme.mjs)")
       .join("the light token block in src/app/globals.css");
  s = s.split("light-theme.css remaps").join("the light token block remaps");
  s = s.split("(scripts/generate-light-theme.mjs)").join("(the light block in globals.css)");
  write(file, s);
}
console.log("suites and harness retargeted");
