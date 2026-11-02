// scripts/prepare-mascot-assets.mjs
//
// STAGE 0 of the GLITCH mascot rollout — asset preparation only. No app code
// reads these files yet.
//
// WHY A SCRIPT AND NOT A ONE-LINE THRESHOLD
// The six source PNGs are RGB with NO alpha channel (PNG colour type 2), so
// their "transparent" background is really an opaque studio backdrop: near-white
// for five of them, a light periwinkle/lavender gradient for `victory`. The
// artwork also contains two things a naive key destroys:
//
//   * ivory facial detail (#FBF0DC-ish eyes and mouth), which any "delete light
//     pixels" rule punches straight out;
//   * saturated cyan and coral confetti scattered AROUND the mascot, including
//     detached pieces floating on the backdrop, which a luminance-only key
//     removes.
//
// So: flood-fill from the border with a NEUTRAL-AND-LIGHT predicate (the
// backdrop is neutral; the confetti is not, and the eyes are enclosed by the
// dark body so the fill cannot reach them), then reconstruct coverage in the
// one-pixel antialiased band, then drop the detached floor-shadow ellipse.
//
// The coverage maths. A band pixel is a blend of the backdrop B and the nearby
// opaque artwork F, so coverage a = |C-B| / |F-B|. F comes from propagating the
// nearest opaque colour inward a few pixels. The band pixel is then re-coloured
// with F rather than the blend, which is what de-fringes it: a 50%-covered edge
// pixel becomes "the body colour at 50% alpha" instead of "a pale grey ghost".
//
// Usage:
//   node scripts/prepare-mascot-assets.mjs
//
// Sources are read from assets/mascot-source/ (their home after the archive
// move) or, on a fresh checkout, from the repository root. Outputs are written
// to public/images/mascot/. Verification sheets are written next to the source
// archive so the removal can be eyeballed on GRYND's own background.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const OUT_DIR = path.join(ROOT, "public", "images", "mascot");
const ARCHIVE_DIR = path.join(ROOT, "assets", "mascot-source");
const MASTER_DIR = path.join(ARCHIVE_DIR, "masters");

const MASTER_SIZE = 1024;
// 384 is the 2x asset for a ~192 CSS-px render; 192 is the 1x.
const OUTPUT_SIZES = [
  { suffix: "", px: 384 },
  { suffix: "-192", px: 192 },
];
// How much of the square master canvas the artwork may occupy. The SINGLE
// scale factor below is shared by all six expressions, so they stay optically
// consistent with each other.
const FILL = 0.92;
// How far the nearest opaque colour is propagated into the keyed band.
const PROPAGATE_ITERATIONS = 8;
// Coverage is reconstructed only this far outside the fill. Beyond it a pixel
// is interior artwork and stays fully opaque.
//
// This bound is what keeps a lighter body from being eaten. The victory
// backdrop is a lavender gradient and the mascot has its own lavender shading,
// so a generous "blueish and bright" fill predicate walks straight past the
// silhouette and into the body: measured, 24% of victory's antialiased band was
// isolated inside the artwork and 516 pixels of body were left half-opaque. With
// the fill kept conservative and the soft edge reconstructed only in a short
// band, a body highlight a few pixels further in can never become transparent.
const EDGE_BAND_PX = 3;
// A detached component is the floor shadow if its OPAQUE CORE is desaturated
// and light. The core matters: a component's overall mean is pulled toward the
// backdrop by its antialiased rim, which makes saturated confetti look pale
// enough to be mistaken for a shadow. Core colours are unambiguous — cyan
// ~193 chroma, coral ~145, the grey ellipse ~4, victory's purple one ~36.
const SHADOW_CORE_MAX_CHROMA = 60;
const SHADOW_CORE_MIN_LUM = 100;
// Only removals at least this large are worth a log line; the rest is speckle.
const SHADOW_LOG_MIN_PX = 40;
// Widened by this many pixels before the shadow's alpha is cleared, to catch
// the shadow's own antialiased rim.
const SHADOW_DILATE = 2;

const ASSETS = [
  { expression: "idle", source: "glitch.png", key: "white" },
  { expression: "wink", source: "glitch wink.png", key: "white" },
  { expression: "victory", source: "glitch victory.png", key: "periwinkle" },
  { expression: "defeat", source: "glitch defeat.png", key: "white" },
  { expression: "surprised", source: "glitch suprised.png", key: "white" },
  { expression: "focused", source: "glitch focused.png", key: "white" },
];

// ── colour helpers ────────────────────────────────────────────────────────
const lumOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const chromaOf = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const rgbDist = (r1, g1, b1, r2, g2, b2) =>
  Math.hypot(r1 - r2, g1 - g2, b1 - b2);

/**
 * Is this pixel part of the studio backdrop?
 *
 * `white`     — neutral AND light. The neutrality test is what saves the
 *               saturated confetti; the lightness test is what stops the fill
 *               at the dark body.
 * `periwinkle` — blue-dominant and reasonably bright. The victory backdrop is
 *               a lavender gradient, so there is no white to key at all, and
 *               luminance alone would also catch the mascot's lavender floor
 *               shadow (which is detached, so it is removed separately).
 */
function isBackdropPixel(key, r, g, b) {
  if (key === "periwinkle") {
    // Deliberately conservative (lum >= 115, not 95): the backdrop measures
    // ~145–170, a 50%-covered edge pixel ~103, and the body's lavender
    // highlight ~111. Stopping at 115 keeps the fill outside the body while
    // still reaching every real backdrop pixel; the 3px edge band below
    // recovers the coverage between them.
    return b - r >= 25 && b >= 120 && lumOf(r, g, b) >= 115;
  }
  return lumOf(r, g, b) >= 95 && chromaOf(r, g, b) <= 30;
}

/** Grow a mask by `passes` pixels (8-connected). */
function dilateMask(mask, w, h, passes) {
  let current = mask;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(current);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (current[i]) continue;
        if (
          (x > 0 && current[i - 1]) ||
          (x < w - 1 && current[i + 1]) ||
          (y > 0 && current[i - w]) ||
          (y < h - 1 && current[i + w])
        ) {
          next[i] = 1;
        }
      }
    }
    current = next;
  }
  return current;
}

/** Median of the outermost ring — a robust backdrop colour for the unmixing. */
function estimateBackdrop(rgba, w, h, ring = 4) {
  const rs = [];
  const gs = [];
  const bs = [];
  const sample = (x, y) => {
    const p = (y * w + x) * 4;
    rs.push(rgba[p]);
    gs.push(rgba[p + 1]);
    bs.push(rgba[p + 2]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < ring; x++) {
      sample(x, y);
      sample(w - 1 - x, y);
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < ring; y++) {
      sample(x, y);
      sample(x, h - 1 - y);
    }
  }
  const median = (arr) => arr.sort((a, b) => a - b)[arr.length >> 1];
  return [median(rs), median(gs), median(bs)];
}

/**
 * Border-connected flood fill over backdrop-like pixels.
 *
 * Connectivity is what preserves the enclosed ivory eyes: they are light, but
 * the dark face surrounds them, so the fill never reaches them.
 */
function floodBackdrop(rgba, w, h, key) {
  const n = w * h;
  const mask = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;

  const visit = (i) => {
    if (mask[i]) return;
    const p = i * 4;
    if (!isBackdropPixel(key, rgba[p], rgba[p + 1], rgba[p + 2])) return;
    mask[i] = 1;
    stack[sp++] = i;
  };

  for (let x = 0; x < w; x++) {
    visit(x);
    visit((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    visit(y * w);
    visit(y * w + w - 1);
  }

  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (y > 0) visit(i - w);
    if (y < h - 1) visit(i + w);
  }

  return mask;
}

/** Push the nearest opaque artwork colour into the keyed band. */
function propagateForeground(rgba, mask, w, h, iterations) {
  const n = w * h;
  let known = new Uint8Array(n);
  let fr = new Float32Array(n);
  let fg = new Float32Array(n);
  let fb = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    if (mask[i]) continue;
    const p = i * 4;
    known[i] = 1;
    fr[i] = rgba[p];
    fg[i] = rgba[p + 1];
    fb[i] = rgba[p + 2];
  }

  for (let pass = 0; pass < iterations; pass++) {
    const nextKnown = known.slice();
    const nr = fr.slice();
    const ng = fg.slice();
    const nb = fb.slice();
    let grew = false;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;

        let count = 0;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const j = ny * w + nx;
            if (!known[j]) continue;
            count++;
            sr += fr[j];
            sg += fg[j];
            sb += fb[j];
          }
        }
        if (!count) continue;
        nextKnown[i] = 1;
        nr[i] = sr / count;
        ng[i] = sg / count;
        nb[i] = sb / count;
        grew = true;
      }
    }

    known = nextKnown;
    fr = nr;
    fg = ng;
    fb = nb;
    if (!grew) break;
  }

  return { known, fr, fg, fb };
}

/**
 * Build the RGBA image: alpha = coverage, colour = the nearby artwork colour.
 * Keyed pixels that the propagation never reached are deep background → 0.
 */
function buildRgba(rgba, mask, prop, w, h, backdrop) {
  const n = w * h;
  const out = Buffer.alloc(n * 4);
  const alpha = new Float32Array(n);
  const [br, bgCol, bb] = backdrop;
  // The soft edge exists between the fill and the artwork: everything in the
  // fill is background, everything just outside it may be partly covered, and
  // everything further in is opaque.
  const band = dilateMask(mask, w, h, EDGE_BAND_PX);

  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];

    if (!mask[i] && !(band[i] && prop.known[i])) {
      // Interior artwork — untouched, fully opaque.
      alpha[i] = 1;
      out[p] = r;
      out[p + 1] = g;
      out[p + 2] = b;
      out[p + 3] = 255;
      continue;
    }

    if (!prop.known[i]) {
      alpha[i] = 0;
      out[p + 3] = 0;
      continue;
    }

    const dB = rgbDist(r, g, b, br, bgCol, bb);
    const dF = rgbDist(prop.fr[i], prop.fg[i], prop.fb[i], br, bgCol, bb);
    let a;
    if (dF > 8) a = dB / dF;
    else a = dB > 8 ? 1 : 0;
    a = clamp01(a);

    // Re-colour with the local artwork colour (this is the de-fringe), then
    // carry the coverage in alpha.
    out[p] = clamp255(Math.round(prop.fr[i]));
    out[p + 1] = clamp255(Math.round(prop.fg[i]));
    out[p + 2] = clamp255(Math.round(prop.fb[i]));
    out[p + 3] = Math.round(a * 255);
    alpha[i] = a;
  }

  return { out, alpha };
}

/** Connected components of coverage, 8-connected, with source colours. */
function labelComponents(coverage, source, w, h, threshold) {
  const n = w * h;
  const labels = new Int32Array(n).fill(-1);
  const components = [];
  const stack = new Int32Array(n);

  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1 || coverage[start] < threshold) continue;

    const id = components.length;
    const list = [];
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumL = 0;
    let sumC = 0;
    // Opaque core only — the part of the component that is definitely artwork.
    let coreR = 0;
    let coreG = 0;
    let coreB = 0;
    let coreL = 0;
    let coreC = 0;
    let coreCount = 0;

    while (sp > 0) {
      const i = stack[--sp];
      list.push(i);
      const x = i % w;
      const y = (i - x) / w;
      const p = i * 4;
      const r = source[p];
      const g = source[p + 1];
      const b = source[p + 2];
      sumR += r;
      sumG += g;
      sumB += b;
      sumL += lumOf(r, g, b);
      sumC += chromaOf(r, g, b);
      if (coverage[i] >= 0.9) {
        coreCount++;
        coreR += r;
        coreG += g;
        coreB += b;
        coreL += lumOf(r, g, b);
        coreC += chromaOf(r, g, b);
      }

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (labels[j] !== -1 || coverage[j] < threshold) continue;
          labels[j] = id;
          stack[sp++] = j;
        }
      }
    }

    const count = list.length;
    // Fall back to the whole component when it has no fully opaque pixel (a soft
    // glow or a shadow the key already faded).
    const useCore = coreCount > 0;
    const n = useCore ? coreCount : count;
    components.push({
      id,
      count,
      coreCount,
      pixels: list,
      meanLum: sumL / count,
      meanChroma: sumC / count,
      meanRgb: [sumR / count, sumG / count, sumB / count],
      coreLum: (useCore ? coreL : sumL) / n,
      coreChroma: (useCore ? coreC : sumC) / n,
      coreRgb: [
        (useCore ? coreR : sumR) / n,
        (useCore ? coreG : sumG) / n,
        (useCore ? coreB : sumB) / n,
      ],
    });
  }

  return { labels, components };
}

/**
 * Clear the detached floor-shadow ellipse.
 *
 * Detection runs at a LOW coverage threshold (0.02) on purpose. The shadow is a
 * light, desaturated ellipse, so the backdrop fill already reaches it and leaves
 * it at partial coverage — a faint haze that a 0.5 threshold would never see.
 * Colours are sampled from the ORIGINAL image, because the keyed buffer
 * deliberately re-colours band pixels with the nearby artwork colour.
 *
 * Components are classified, never individual pixel colours: the shadow is the
 * only detached thing that is both desaturated and light. Confetti is also
 * detached but strongly saturated (cyan ~193 chroma, coral ~145), and every
 * expression's face is attached to its body, so neither can be mistaken for it.
 */
function removeFloorShadow(source, coverage, w, h, expression) {
  const { components } = labelComponents(coverage, source, w, h, 0.02);
  if (!components.length) return { dropped: [], alpha: coverage };

  const mascot = components.reduce((a, b) => (b.count > a.count ? b : a));
  const dropped = [];
  const cleared = new Uint8Array(w * h);

  for (const component of components) {
    if (component.id === mascot.id) continue;
    const isShadow =
      component.coreChroma < SHADOW_CORE_MAX_CHROMA &&
      component.coreLum > SHADOW_CORE_MIN_LUM;
    if (!isShadow) continue;
    dropped.push({
      expression,
      count: component.count,
      coreCount: component.coreCount,
      coreLum: Math.round(component.coreLum),
      coreChroma: Math.round(component.coreChroma),
      coreRgb: component.coreRgb.map(Math.round),
    });
    for (const i of component.pixels) {
      coverage[i] = 0;
      cleared[i] = 1;
    }
  }

  // Take the shadow's own antialiased rim with it — but only semi-transparent
  // pixels, so the mascot's opaque silhouette can never be eaten.
  for (let pass = 0; pass < SHADOW_DILATE && dropped.length; pass++) {
    const next = new Uint8Array(cleared);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cleared[i] || coverage[i] >= 0.9) continue;
        let touches = false;
        for (let dy = -1; dy <= 1 && !touches; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            if (cleared[ny * w + nx]) {
              touches = true;
              break;
            }
          }
        }
        if (!touches) continue;
        coverage[i] = 0;
        next[i] = 1;
      }
    }
    cleared.set(next);
  }

  return { dropped, alpha: coverage };
}

/** Bounding box of real coverage, used to trim and to normalise the canvas. */
function contentBox(alpha, w, h, threshold = 0.02) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] <= threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Resolve a source file: the archive first, then a fresh-checkout root copy. */
function resolveSource(filename) {
  const archived = path.join(ARCHIVE_DIR, filename);
  if (fs.existsSync(archived)) return archived;
  const root = path.join(ROOT, filename);
  if (fs.existsSync(root)) return root;
  throw new Error(
    `Missing source image: ${filename} (looked in ${ARCHIVE_DIR} and ${ROOT})`,
  );
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`.padStart(8);
}

// ── per-image processing ──────────────────────────────────────────────────
async function processOne(asset) {
  const sourcePath = resolveSource(asset.source);
  const { data, info } = await sharp(sourcePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  if (info.channels !== 4) throw new Error(`${asset.source}: expected RGBA`);

  const backdrop = estimateBackdrop(data, w, h);
  const mask = floodBackdrop(data, w, h, asset.key);
  const prop = propagateForeground(data, mask, w, h, PROPAGATE_ITERATIONS);
  const { out, alpha: coverage } = buildRgba(data, mask, prop, w, h, backdrop);

  const { dropped, alpha } = removeFloorShadow(
    data,
    coverage,
    w,
    h,
    asset.expression,
  );

  // Apply the final coverage back onto the RGBA buffer.
  for (let i = 0; i < w * h; i++) out[i * 4 + 3] = Math.round(alpha[i] * 255);

  const box = contentBox(alpha, w, h);
  if (!box) throw new Error(`${asset.source}: nothing survived the key`);

  let keyed = 0;
  for (let i = 0; i < w * h; i++) if (alpha[i] > 0.5) keyed++;

  return {
    asset,
    rgba: out,
    width: w,
    height: h,
    box,
    dropped,
    backdrop,
    coveragePct: (keyed / (w * h)) * 100,
  };
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(MASTER_DIR, { recursive: true });

  console.log("GLITCH mascot — preparing transparent assets\n");

  const processed = [];
  for (const asset of ASSETS) {
    process.stdout.write(`  keying ${asset.source} … `);
    const result = await processOne(asset);
    processed.push(result);
    console.log(
      `${result.box.width}x${result.box.height} subject box, ` +
        `${result.coveragePct.toFixed(1)}% opaque, ` +
        `backdrop rgb(${result.backdrop.map(Math.round).join(",")})`,
    );
    const notable = result.dropped.filter((s) => s.count >= SHADOW_LOG_MIN_PX);
    for (const shadow of notable) {
      console.log(
        `    removed detached shadow: ${shadow.count} px, core rgb(${shadow.coreRgb.join(",")}), ` +
          `core lum ${shadow.coreLum}, core chroma ${shadow.coreChroma}`,
      );
    }
    const specks = result.dropped.length - notable.length;
    if (specks > 0) {
      const speckPx = result.dropped
        .filter((s) => s.count < SHADOW_LOG_MIN_PX)
        .reduce((total, s) => total + s.count, 0);
      console.log(
        `    cleared ${specks} background speck(s) (${speckPx} px total) — backdrop noise, not artwork`,
      );
    }
  }

  // ONE scale for all six, derived from the widest content box, so no
  // expression is cropped and they all stay optically consistent.
  const scale = Math.min(
    ...processed.map((p) => (FILL * MASTER_SIZE) / Math.max(p.box.width, p.box.height)),
  );
  console.log(`\n  shared scale factor: ${scale.toFixed(4)}`);

  const report = [];

  for (const item of processed) {
    const targetW = Math.round(item.box.width * scale);
    const targetH = Math.round(item.box.height * scale);

    // Trim to the content, scale, then centre on a transparent square master.
    const scaled = await sharp(item.rgba, {
      raw: { width: item.width, height: item.height, channels: 4 },
    })
      .extract({
        left: item.box.x,
        top: item.box.y,
        width: item.box.width,
        height: item.box.height,
      })
      .resize(targetW, targetH, { fit: "fill", kernel: "lanczos3" })
      .raw()
      .toBuffer();

    const left = Math.round((MASTER_SIZE - targetW) / 2);
    const top = Math.round((MASTER_SIZE - targetH) / 2);
    const master = await sharp({
      create: {
        width: MASTER_SIZE,
        height: MASTER_SIZE,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: scaled, raw: { width: targetW, height: targetH, channels: 4 }, left, top }])
      .png({ compressionLevel: 9 })
      .toBuffer();

    const masterPath = path.join(MASTER_DIR, `glitch-${item.asset.expression}.png`);
    fs.writeFileSync(masterPath, master);

    const sockets = [];
    for (const size of OUTPUT_SIZES) {
      const file = `glitch-${item.asset.expression}${size.suffix}.webp`;
      const outPath = path.join(OUT_DIR, file);
      await sharp(master)
        .resize(size.px, size.px, { fit: "contain", kernel: "lanczos3" })
        .webp({ quality: 90, alphaQuality: 100, effort: 6, smartSubsample: true })
        .toFile(outPath);

      const bytes = fs.statSync(outPath).size;
      const meta = await sharp(outPath).metadata();
      sockets.push({ file, px: size.px, bytes, hasAlpha: meta.hasAlpha });
    }

    report.push({
      expression: item.asset.expression,
      source: item.asset.source,
      box: `${item.box.width}x${item.box.height}`,
      coverage: item.coveragePct,
      placed: `${targetW}x${targetH}`,
      sockets,
      masterBytes: master.length,
    });
  }

  // ── verification report ────────────────────────────────────────────────
  console.log("\n── output ──────────────────────────────────────────────────────");
  for (const row of report) {
    for (const socket of row.sockets) {
      console.log(
        `  ${socket.file.padEnd(26)} ${socket.px}x${socket.px}  ` +
          `${formatKb(socket.bytes)}  alpha=${socket.hasAlpha ? "yes" : "NO"}`,
      );
    }
  }
  const worst = Math.max(...report.flatMap((r) => r.sockets.map((s) => s.bytes)));
  const bytesAll = report.flatMap((r) => r.sockets.map((s) => s.bytes));
  console.log(
    `  total ${(bytesAll.reduce((a, b) => a + b, 0) / 1024).toFixed(1)} KB ` +
      `· largest ${(worst / 1024).toFixed(1)} KB ` +
      `· target 15–40 KB per 384 asset`,
  );

  // ── contact sheet: native 192 / 96 / 48 on GRYND's page colour ─────────
  const GROUND = "#030817";
  const LABEL = "#7dd3fc";
  const ACCENT = "#00e5ff";
  const COLS = ASSETS.length;
  const CELL = 192;
  const GAP = 36;
  const PAD = 32;
  const HEADER = 34;
  const FOOTER = 30;
  const ROWS = [
    { px: 192, label: "192 px (native 2x)" },
    { px: 96, label: "96 px" },
    { px: 48, label: "48 px" },
  ];

  const rowHeights = ROWS.map((r) => r.px + HEADER);
  const sheetW = PAD * 2 + COLS * CELL + (COLS - 1) * GAP;
  const sheetH =
    PAD * 2 +
    rowHeights.reduce((a, b) => a + b, 0) +
    (ROWS.length - 1) * GAP +
    FOOTER;

  const labelSvg = [];
  let cursorY = PAD;

  for (let r = 0; r < ROWS.length; r++) {
    // The caption sits BELOW its row: above the row it collides with the first
    // column's expression label, and to the right it collides with the last one.
    labelSvg.push(
      `<text x="${PAD}" y="${cursorY + HEADER + ROWS[r].px + 16}" fill="${ACCENT}" ` +
        `font-family="monospace" font-size="12" letter-spacing="1">` +
        `${ROWS[r].label.toUpperCase()}</text>`,
    );
    cursorY += rowHeights[r] + GAP;
  }

  const titleSvg =
    `<text x="${PAD}" y="${sheetH - 10}" fill="${LABEL}" opacity="0.55" ` +
    `font-family="monospace" font-size="12">` +
    `GLITCH — transparent WebP on ${GROUND} · ${ASSETS.map((a) => a.expression).join(" / ")}` +
    `</text>`;

  const overlays = [];
  cursorY = PAD;
  for (const row of ROWS) {
    for (let c = 0; c < COLS; c++) {
      const expression = ASSETS[c].expression;
      const source = path.join(OUT_DIR, `glitch-${expression}.webp`);
      const buffer = await sharp(source)
        .resize(row.px, row.px, { fit: "contain", kernel: "lanczos3" })
        .png()
        .toBuffer();
      overlays.push({
        input: buffer,
        left: PAD + c * (CELL + GAP) + Math.round((CELL - row.px) / 2),
        top: cursorY + HEADER,
      });
      if (row.px === 192) {
        labelSvg.push(
          `<text x="${PAD + c * (CELL + GAP)}" y="${cursorY + 14}" fill="${LABEL}" ` +
            `font-family="monospace" font-size="13">${ASSETS[c].expression}</text>`,
        );
      }
    }
    cursorY += row.px + HEADER + GAP;
  }

  const sheetSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}">` +
    `<rect width="100%" height="100%" fill="${GROUND}"/>` +
    labelSvg.join("") +
    titleSvg +
    `</svg>`;

  const sheetPath = path.join(ARCHIVE_DIR, "contact-sheet.png");
  await sharp(Buffer.from(sheetSvg))
    .composite(overlays)
    .png({ compressionLevel: 9 })
    .toFile(sheetPath);

  // ── edge check: 4x nearest-neighbour zoom on the silhouette ────────────
  const ZOOM = 4;
  const CROP = 120;
  const edgeTargets = ["idle", "wink", "victory"];
  const chips = [];

  for (const expression of edgeTargets) {
    const file = path.join(OUT_DIR, `glitch-${expression}.webp`);
    const { data: px, info: pi } = await sharp(file)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width: ew, height: eh } = pi;

    // Anchor on the leftmost solid pixel near mid-height: a real silhouette edge.
    let anchorX = ew;
    let anchorY = Math.round(eh * 0.55);
    for (let y = Math.round(eh * 0.3); y < Math.round(eh * 0.8); y++) {
      for (let x = 0; x < ew; x++) {
        if (px[(y * ew + x) * 4 + 3] > 160) {
          if (x < anchorX) {
            anchorX = x;
            anchorY = y;
          }
          break;
        }
      }
    }

    const left = Math.max(0, Math.min(ew - CROP, anchorX - CROP / 2));
    const top = Math.max(0, Math.min(eh - CROP, anchorY - CROP / 2));
    const chip = await sharp(file)
      .extract({ left, top, width: CROP, height: CROP })
      .resize(CROP * ZOOM, CROP * ZOOM, { kernel: "nearest", fit: "fill" })
      .png()
      .toBuffer();
    chips.push({ input: chip, left: PAD + chips.length * (CROP * ZOOM + GAP), top: PAD + 24, expression });
  }

  const edgeW = PAD * 2 + edgeTargets.length * CROP * ZOOM + (edgeTargets.length - 1) * GAP;
  const edgeH = PAD * 2 + 24 + CROP * ZOOM;
  const edgeSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${edgeW}" height="${edgeH}">` +
    `<rect width="100%" height="100%" fill="${GROUND}"/>` +
    edgeTargets
      .map(
        (expression, i) =>
          `<text x="${PAD + i * (CROP * ZOOM + GAP)}" y="${PAD + 14}" ` +
          `fill="${LABEL}" font-family="monospace" font-size="12">` +
          `${expression} — 4x edge zoom</text>`,
      )
      .join("") +
    `</svg>`;

  const edgePath = path.join(ARCHIVE_DIR, "edge-check.png");
  await sharp(Buffer.from(edgeSvg))
    .composite(chips.map(({ expression, ...rest }) => rest))
    .png({ compressionLevel: 9 })
    .toFile(edgePath);

  // ── halo check: magenta ground ────────────────────────────────────────
  // A white or lavender fringe is nearly invisible on GRYND's near-black page
  // but shouts on saturated magenta, so this sheet is the honest test that the
  // backdrop is gone rather than merely hidden.
  const HALO_CELL = 256;
  const HALO_LABEL = 24;
  const haloOverlays = [];
  const haloLabels = [];

  for (let i = 0; i < ASSETS.length; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const left = PAD + col * (HALO_CELL + GAP);
    const top = PAD + row * (HALO_CELL + HALO_LABEL + GAP) + HALO_LABEL;
    const buffer = await sharp(path.join(OUT_DIR, `glitch-${ASSETS[i].expression}.webp`))
      .resize(HALO_CELL, HALO_CELL, { fit: "contain", kernel: "lanczos3" })
      .png()
      .toBuffer();
    haloOverlays.push({ input: buffer, left, top });
    haloLabels.push(
      `<text x="${left}" y="${top - 8}" fill="#ffffff" ` +
        `font-family="monospace" font-size="12">${ASSETS[i].expression}</text>`,
    );
  }

  const haloW = PAD * 2 + 3 * HALO_CELL + 2 * GAP;
  const haloH = PAD * 2 + 2 * (HALO_CELL + HALO_LABEL) + GAP;
  const haloPath = path.join(ARCHIVE_DIR, "halo-check.png");
  await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${haloW}" height="${haloH}">` +
        `<rect width="100%" height="100%" fill="#FF00FF"/>` +
        haloLabels.join("") +
        `</svg>`,
    ),
  )
    .composite(haloOverlays)
    .png({ compressionLevel: 9 })
    .toFile(haloPath);

  console.log(
    `\n  verification sheets:\n` +
      `    ${path.relative(ROOT, sheetPath)}  (${(fs.statSync(sheetPath).size / 1024).toFixed(0)} KB)\n` +
      `    ${path.relative(ROOT, edgePath)}  (${(fs.statSync(edgePath).size / 1024).toFixed(0)} KB)\n` +
      `    ${path.relative(ROOT, haloPath)}  (${(fs.statSync(haloPath).size / 1024).toFixed(0)} KB)\n` +
      `    ${path.relative(ROOT, MASTER_DIR)}/  (transparent PNG masters)\n`,
  );

  // Machine-readable summary for the report.
  fs.writeFileSync(
    path.join(ARCHIVE_DIR, "asset-report.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ground: GROUND,
        scale,
        outputs: report.map((row) => ({
          expression: row.expression,
          source: row.source,
          sourceBox: row.box,
          coveragePct: Number(row.coverage.toFixed(1)),
          placedOnMaster: row.placed,
          masterKb: Number((row.masterBytes / 1024).toFixed(1)),
          webp: row.sockets.map((s) => ({
            file: s.file,
            px: s.px,
            kb: Number((s.bytes / 1024).toFixed(1)),
            hasAlpha: s.hasAlpha,
          })),
        })),
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((error) => {
  console.error("\n✗ Mascot asset preparation failed:");
  console.error(error);
  process.exit(1);
});
