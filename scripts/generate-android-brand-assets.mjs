// scripts/generate-android-brand-assets.mjs
//
// Phase 7 — GRYND launcher icon + splash branding for the Capacitor Android app.
//
//   node scripts/generate-android-brand-assets.mjs
//
// Source of truth is public/icon-512.png — the existing GRYND app icon (the
// canonical yellow "G" mark on a black field). Nothing is redrawn, recoloured,
// re-proportioned or replaced: the script lifts the mark off its black field
// (luminance -> alpha, the same separation scripts/generate-og-banner.mjs does
// with a screen blend), trims it to its own bounding box, and re-centres it at
// the size each Android resource expects.
//
// Outputs (all overwrite stock Capacitor/Android Studio template art):
//   mipmap-<density>/ic_launcher_foreground.png   adaptive foreground, transparent
//   mipmap-<density>/ic_launcher.png              legacy square icon (API < 26)
//   mipmap-<density>/ic_launcher_round.png        legacy round icon  (API < 26)
//   drawable/splash.png                           launch drawable + every
//   drawable-port-*/splash.png                    density/orientation variant,
//   drawable-land-*/splash.png                    at the template's own pixel sizes
//
// The adaptive background colour lives in values/ic_launcher_background.xml and
// values-v31/styles.xml; both are hand-maintained and use the same navy below.
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "public/icon-512.png");
const RES = path.join(ROOT, "android/app/src/main/res");

// GRYND's dark theme base (docs/GRYND_ICON_SPEC.md §5, android values/styles.xml).
const NAVY = "#030817";
const NAVY_MID = "#071536";
const NAVY_HIGH = "#0a2450";

// Pixels darker than this on every channel are the source's black field.
const BLACK_CUTOFF = 16;

// Adaptive icons: the visible area is the central 66 of 108dp, so the mark is
// kept well inside that safe zone instead of running into any launcher mask.
const FOREGROUND_MARK = 0.6;

// Legacy (API < 26) icons are not mask-cropped, but launchers still round them,
// so the mark keeps a healthy margin.
const LEGACY_MARK = 0.66;
const ROUND_MARK = 0.62;

// Splash mark size, as a fraction of the shortest screen edge.
const SPLASH_MARK = 0.22;

const DENSITIES = [
  { dir: "mdpi", scale: 1 },
  { dir: "hdpi", scale: 1.5 },
  { dir: "xhdpi", scale: 2 },
  { dir: "xxhdpi", scale: 3 },
  { dir: "xxxhdpi", scale: 4 },
];

// Same pixel sizes the Capacitor template ships, so the plugin's FIT_XY scaling
// and the existing theme behaviour are unchanged.
const SPLASH = [
  { dir: "drawable", file: "splash.png", width: 480, height: 320 },
  { dir: "drawable-port-mdpi", file: "splash.png", width: 320, height: 480 },
  { dir: "drawable-port-hdpi", file: "splash.png", width: 480, height: 800 },
  { dir: "drawable-port-xhdpi", file: "splash.png", width: 720, height: 1280 },
  { dir: "drawable-port-xxhdpi", file: "splash.png", width: 960, height: 1600 },
  { dir: "drawable-port-xxxhdpi", file: "splash.png", width: 1280, height: 1920 },
  { dir: "drawable-land-mdpi", file: "splash.png", width: 480, height: 320 },
  { dir: "drawable-land-hdpi", file: "splash.png", width: 800, height: 480 },
  { dir: "drawable-land-xhdpi", file: "splash.png", width: 1280, height: 720 },
  { dir: "drawable-land-xxhdpi", file: "splash.png", width: 1600, height: 960 },
  { dir: "drawable-land-xxxhdpi", file: "splash.png", width: 1920, height: 1280 },
];

// --- 1. Lift the mark off its black field --------------------------------
const { data, info } = await sharp(SRC)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

let sumR = 0;
let sumG = 0;
let sumB = 0;
let bright = 0;

for (let i = 0; i < data.length; i += 4) {
  const alpha = Math.max(data[i], data[i + 1], data[i + 2]);

  if (alpha < BLACK_CUTOFF) {
    // Source background: fully transparent.
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = 0;
    continue;
  }

  // Un-premultiply against black so anti-aliased edges keep the full mark
  // colour instead of darkening into a grey fringe on the navy background.
  data[i] = Math.min(255, Math.round((data[i] * 255) / alpha));
  data[i + 1] = Math.min(255, Math.round((data[i + 1] * 255) / alpha));
  data[i + 2] = Math.min(255, Math.round((data[i + 2] * 255) / alpha));
  data[i + 3] = alpha;

  if (alpha > 200) {
    sumR += data[i];
    sumG += data[i + 1];
    sumB += data[i + 2];
    bright += 1;
  }
}

if (bright === 0) {
  throw new Error(`${SRC} has no visible mark — refusing to write blank icons.`);
}

const markColour = `#${[sumR, sumG, sumB]
  .map((v) => Math.round(v / bright).toString(16).padStart(2, "0"))
  .join("")}`;

// --- 2. Trim to the mark's bounding box ----------------------------------
let minX = info.width;
let minY = info.height;
let maxX = -1;
let maxY = -1;
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] > 0) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
}

const trimmed = await sharp(data, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .extract({
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  })
  .png()
  .toBuffer();

const trimmedMeta = await sharp(trimmed).metadata();

/** Scale the trimmed mark so its longest side is `target` px. */
async function markAt(target) {
  const buffer = await sharp(trimmed)
    .resize({
      width: Math.round(target),
      height: Math.round(target),
      fit: "inside",
      withoutEnlargement: false,
      kernel: "lanczos3",
    })
    .png()
    .toBuffer();
  const meta = await sharp(buffer).metadata();
  return { buffer, width: meta.width, height: meta.height };
}

async function write(file, composite) {
  await mkdir(path.dirname(file), { recursive: true });
  await sharp(composite.base)
    .composite(composite.layers)
    .png({ compressionLevel: 9 })
    .toFile(file);
  const meta = await sharp(file).metadata();
  console.log(
    `  ${path.relative(ROOT, file).replace(/\\/g, "/")}  ${meta.width}x${meta.height}`,
  );
}

const transparent = (width, height) => ({
  create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
});

function navyRectSvg(width, height) {
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
       <rect width="100%" height="100%" fill="${NAVY}"/>
     </svg>`,
  );
}

function navyCircleSvg(width, height) {
  const r = Math.min(width, height) / 2;
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
       <circle cx="${width / 2}" cy="${height / 2}" r="${r}" fill="${NAVY}"/>
     </svg>`,
  );
}

function splashSvg(width, height, markHeight) {
  const cx = width / 2;
  const cy = height / 2;
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
       <defs>
         <radialGradient id="base" cx="50%" cy="46%" r="78%">
           <stop offset="0%" stop-color="${NAVY_HIGH}"/>
           <stop offset="45%" stop-color="${NAVY_MID}"/>
           <stop offset="100%" stop-color="${NAVY}"/>
         </radialGradient>
         <radialGradient id="halo" cx="50%" cy="50%" r="50%">
           <stop offset="0%" stop-color="#00e5ff" stop-opacity="0.14"/>
           <stop offset="60%" stop-color="#00e5ff" stop-opacity="0.04"/>
           <stop offset="100%" stop-color="#00e5ff" stop-opacity="0"/>
         </radialGradient>
       </defs>
       <rect width="100%" height="100%" fill="url(#base)"/>
       <ellipse cx="${cx}" cy="${cy}" rx="${markHeight * 1.15}" ry="${markHeight * 1.15}" fill="url(#halo)"/>
     </svg>`,
  );
}

console.log(`Source mark: public/icon-512.png  (${markColour})`);
console.log(
  `Trimmed to ${trimmedMeta.width}x${trimmedMeta.height} (from ${info.width}x${info.height})`,
);

// --- 3. Launcher icons ---------------------------------------------------
for (const { dir, scale } of DENSITIES) {
  const foregroundSize = Math.round(108 * scale);
  const legacySize = Math.round(48 * scale);

  const foreground = await markAt(foregroundSize * FOREGROUND_MARK);
  await write(path.join(RES, `mipmap-${dir}/ic_launcher_foreground.png`), {
    base: transparent(foregroundSize, foregroundSize),
    layers: [
      {
        input: foreground.buffer,
        left: Math.round((foregroundSize - foreground.width) / 2),
        top: Math.round((foregroundSize - foreground.height) / 2),
      },
    ],
  });

  const legacy = await markAt(legacySize * LEGACY_MARK);
  await write(path.join(RES, `mipmap-${dir}/ic_launcher.png`), {
    base: navyRectSvg(legacySize, legacySize),
    layers: [
      {
        input: legacy.buffer,
        left: Math.round((legacySize - legacy.width) / 2),
        top: Math.round((legacySize - legacy.height) / 2),
      },
    ],
  });

  const round = await markAt(legacySize * ROUND_MARK);
  await write(path.join(RES, `mipmap-${dir}/ic_launcher_round.png`), {
    base: navyCircleSvg(legacySize, legacySize),
    layers: [
      {
        input: round.buffer,
        left: Math.round((legacySize - round.width) / 2),
        top: Math.round((legacySize - round.height) / 2),
      },
    ],
  });
}

// --- 4. Splash drawables -------------------------------------------------
for (const { dir, file, width, height } of SPLASH) {
  const markHeight = Math.round(Math.min(width, height) * SPLASH_MARK);
  const mark = await markAt(markHeight);
  await write(path.join(RES, dir, file), {
    base: splashSvg(width, height, markHeight),
    layers: [
      {
        input: mark.buffer,
        left: Math.round((width - mark.width) / 2),
        top: Math.round((height - mark.height) / 2),
      },
    ],
  });
}

console.log("Done. GRYND branding written to android/app/src/main/res/.");
