// qa/ta-fall-motion-check.mjs
//
// Verifies the exact animation mechanism Tower Arena's drop animation relies
// on: a <motion.g> whose children sit at final coordinates, translated up by
// `y: -dropDz` (in SVG user units) and animated back to y:0 — using the SAME
// framer-motion + react-dom versions the app ships. If this pattern doesn't
// produce a visible vertical sweep, the drop can never look like a fall.
//
// Run: node qa/ta-fall-motion-check.mjs

import { chromium } from "playwright";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esbuild from "esbuild";

if (!existsSync("node_modules/framer-motion") || !existsSync("node_modules/react-dom")) {
  console.log("deps not installed — run npm ci first");
  process.exit(1);
}
const fmPkg = JSON.parse(await import("node:fs").then((f) => f.readFileSync("node_modules/framer-motion/package.json", "utf8")));
const reactPkg = JSON.parse(await import("node:fs").then((f) => f.readFileSync("node_modules/react/package.json", "utf8")));
console.log(`framer-motion ${fmPkg.version} · react ${reactPkg.version}`);

// Replicates TowerScene's geometry with plain createElement (no JSX).
const entry = `
const React = require("react");
const { createRoot } = require("react-dom/client");
const { motion } = require("framer-motion");

const CEILING = 24, SKY = 5;
const fallingMinZ = 3;                       // square landing on the floor
const viewH = Math.max(CEILING + SKY, 4 + SKY); // 29 on a low tower
const dropSpawnZ = Math.min(viewH - 1.5, fallingMinZ + 10);
const dropDz = dropSpawnZ - fallingMinZ;     // 10 cells
const fallSeconds = Math.min(0.9, 0.32 + dropDz * 0.035);
const yFor = (z) => viewH - z;
const cellY = (z) => yFor(z + 1);
const cells = [];
for (let x = 6; x <= 7; x++) for (let z = 2; z <= 3; z++) cells.push({ x, z });

const samples = [];
function Cell({ c }) {
  return React.createElement("rect", {
    x: c.x + 0.02, y: cellY(c.z) + 0.02, width: 0.96, height: 0.96,
    fill: "#f5ff3b", stroke: "#ffffd1", strokeWidth: 0.05, rx: 0.1,
  });
}
function App() {
  const ref = React.useRef(null);
  React.useEffect(() => {
    let raf;
    const t0 = performance.now();
    const rec = (t) => {
      const g = ref.current;
      if (g) {
        const tr = window.getComputedStyle(g).transform || "(none)";
        const b = g.getBBox();
        samples.push({ ms: Math.round(t - t0), transform: tr, y: Math.round(b.y * 100) / 100 });
      }
      if (t - t0 < 2200) raf = requestAnimationFrame(rec);
      else {
        document.getElementById("out").textContent =
          "viewH=" + viewH + " dropDz=" + dropDz + " fallSeconds=" + fallSeconds.toFixed(2) + "\\n" +
          samples.map((s) => s.ms + "ms  y=" + s.y + "  " + s.transform).join("\\n");
      }
    };
    raf = requestAnimationFrame(rec);
    return () => cancelAnimationFrame(raf);
  }, []);
  return React.createElement("svg", { viewBox: "-3.3 0 22.6 " + viewH, width: 373, height: 480 },
    React.createElement(motion.g, {
      ref,
      initial: { x: 0, y: -dropDz, opacity: 0.95 },
      animate: { x: 0, y: 0, opacity: 1 },
      transition: {
        x: { duration: fallSeconds, ease: "easeIn" },
        y: { duration: fallSeconds, ease: "easeIn" },
        opacity: { duration: 0.12 },
      },
    }, cells.map((c, i) => React.createElement(Cell, { c, key: i }))));
}
createRoot(document.getElementById("root")).render(React.createElement(App));
window.__ready = true;
`;

const tmp = mkdtempSync(join(tmpdir(), "ta-fall-check-"));
const outFile = join(tmp, "bundle.js");
await esbuild.build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: "js" },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: outFile,
}).then((r) => writeFileSync(outFile, r.outputFiles[0].text));

const html = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body>
  <div id="root"></div>
  <div id="out" style="font:12px monospace;white-space:pre"></div>
  <script src="bundle.js"></script>
</body></html>`;
writeFileSync(join(tmp, "index.html"), html);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("file://" + join(tmp, "index.html").replace(/\\/g, "/"));
  await page.waitForFunction(() => document.getElementById("out")?.textContent.length > 50, null, { timeout: 6000 });
  const text = await page.textContent("#out");
  console.log(text);

  // Header carries the expected geometry: "viewH=29 dropDz=10 fallSeconds=0.67"
  const head = text.split("\n")[0];
  const hm = head.match(/dropDz=(\d+)/);
  const fm = head.match(/fallSeconds=([\d.]+)/);
  const dropDz = hm ? +hm[1] : 0;
  const fallSeconds = fm ? +fm[1] : 0;

  // getBBox ignores transforms, so the real evidence is the group's computed
  // transform matrix: matrix(1,0,0,1,0,ty). ty starts at -dropDz (high in the
  // sky) and eases toward 0 (the landing) as the block falls.
  const samples = text.split("\n").slice(1).map((l) => {
    const m = l.match(/^(\d+)ms\s+y=[-\d.]+\s+matrix\(1, 0, 0, 1, 0, (-?[\d.]+)\)/);
    return m ? { ms: +m[1], ty: +m[2] } : null;
  }).filter(Boolean);
  const first = samples[0], last = samples[samples.length - 1];
  // closest-to-zero ty = the block near its landing
  const landed = samples.reduce((a, b) => (Math.abs(b.ty) < Math.abs(a.ty) ? b : a));
  const travel = landed.ty - first.ty;
  console.log(`\nfall travel: ${travel.toFixed(1)} user units (ty ${first.ty} → ${landed.ty} at ${landed.ms}ms), expected ≈ ${dropDz}`);
  const okStart = Math.abs(first.ty + dropDz) < 1;
  const okTravel = Math.abs(travel - dropDz) < 1.5;
  const okReach = Math.abs(landed.ty) < 1.5; // actually reached the landing spot
  console.log(okStart ? "PASS" : "FAIL", `block starts ${dropDz} user units up (ty=${first.ty})`);
  console.log(okTravel ? "PASS" : "FAIL", `block moves down ~${dropDz} user units`);
  console.log(okReach ? "PASS" : "FAIL", "block reaches its landing spot (ty → 0)");
  if (errors.length) console.log("page errors:", errors.join(" | "));
  process.exitCode = okStart && okTravel && okReach && errors.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}
