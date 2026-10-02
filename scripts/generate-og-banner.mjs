// Builds the default Open Graph / Twitter card image (1200×630) from the brand
// logo, so a link shared to X / LinkedIn / Discord / WhatsApp shows a filled,
// on-brand card instead of the small logo (which platforms letterbox) or the
// old dark banner that read as blank at card size.
//
//   node scripts/generate-og-banner.mjs
//
// The logo (public/images/smalllogo1.png) is a bright yellow glyph on a
// solid-black field. A `screen` blend drops pure black, so after crushing the
// near-black pixels to zero the glyph composites cleanly onto the navy
// background with no visible rectangle around it.
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "public/images/smalllogo1.png");
const OUT = path.join(ROOT, "public/images/og-banner.png");

const WIDTH = 1200;
const HEIGHT = 630;

// Anything darker than this (on every channel) is treated as background and
// zeroed out, so the `screen` blend makes it disappear entirely.
const BLACK_CUTOFF = 40;

// How tall the logo glyph sits inside the 630px canvas.
const LOGO_HEIGHT = 380;

// --- 1. Load the logo and crush near-black to pure black -------------------
const { data, info } = await sharp(SRC)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

for (let i = 0; i < data.length; i += 4) {
  const max = Math.max(data[i], data[i + 1], data[i + 2]);
  if (max < BLACK_CUTOFF) {
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
  }
}

// --- 2. Crop to the glyph's bounding box so placement is predictable -------
let minX = info.width;
let minY = info.height;
let maxX = -1;
let maxY = -1;
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 4;
    if (data[i] > 0 || data[i + 1] > 0 || data[i + 2] > 0) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) {
  throw new Error(`${SRC} appears to be blank — refusing to write a blank banner.`);
}

const glyph = await sharp(data, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
  .resize({ height: LOGO_HEIGHT, fit: "inside" })
  .png()
  .toBuffer();

const glyphMeta = await sharp(glyph).metadata();
const left = Math.round((WIDTH - glyphMeta.width) / 2);
const top = Math.round((HEIGHT - glyphMeta.height) / 2);

// --- 3. Compose: navy gradient + cyan glow + logo --------------------------
// Vector-only background (no text) so it renders identically everywhere.
const background = Buffer.from(`
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="base" cx="50%" cy="46%" r="78%">
      <stop offset="0%" stop-color="#0a2450"/>
      <stop offset="45%" stop-color="#071536"/>
      <stop offset="100%" stop-color="#030817"/>
    </radialGradient>
    <radialGradient id="glow" cx="50%" cy="46%" r="40%">
      <stop offset="0%" stop-color="rgba(0,229,255,0.34)"/>
      <stop offset="60%" stop-color="rgba(0,229,255,0.10)"/>
      <stop offset="100%" stop-color="rgba(0,229,255,0)"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#base)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" fill="none"
        stroke="rgba(0,229,255,0.28)" stroke-width="1"/>
</svg>`);

await mkdir(path.dirname(OUT), { recursive: true });
await sharp(background)
  .composite([{ input: glyph, left, top, blend: "screen" }])
  .png({ compressionLevel: 9, palette: false })
  .toFile(OUT);

console.log(`Wrote ${path.relative(ROOT, OUT)} (${WIDTH}×${HEIGHT})`);
