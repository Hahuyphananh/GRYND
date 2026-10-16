// scripts/generate-icon-assets.mjs
//
// Generates the production WebP assets for the 12 official Grynd icons.
//
// The 1024x1024 PNG masters live in src/images/gryndicon1..12.png. The app
// serves icons from /public/icons/<key>.webp at 512x512 (see
// docs/GRYND_ICON_SPEC.md §15: single 512x512 WebP per icon, ≤300 KB, sRGB).
// This script converts the masters to that production format WITHOUT
// regenerating or altering the artwork itself.
//
// Usage: node scripts/generate-icon-assets.mjs
// Output: public/icons/gryndicon1.webp .. gryndicon12.webp

import sharp from "sharp";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(root, "src/images");
const OUT_DIR = join(root, "public/icons");

const SIZE = 512; // production size per the icon spec
const QUALITY = 88; // high quality, well under the 300 KB budget

const ICONS = Array.from({ length: 12 }, (_, i) => ({
  key: `gryndicon${i + 1}`,
  src: `gryndicon${i + 1}.png`,
}));

for (const { key, src } of ICONS) {
  const srcPath = join(SRC_DIR, src);
  const outPath = join(OUT_DIR, `${key}.webp`);
  await sharp(srcPath)
    .resize({ width: SIZE, height: SIZE, fit: "cover" })
    .webp({ quality: QUALITY })
    .toFile(outPath);

  const meta = await sharp(outPath).metadata();
  const bytes = (await sharp(outPath).toBuffer()).length;
  const ok = meta.width === SIZE && meta.height === SIZE && bytes <= 300 * 1024;
  console.log(
    `${key}.webp  ${meta.width}x${meta.height}  ${(bytes / 1024).toFixed(1)} KB  ${ok ? "OK" : "⚠ CHECK"}`
  );
}
console.log("Done. Assets placed in public/icons/ per /icons/<key>.webp convention.");
