// scripts/generate-16x9-card-images.mjs
//
// Generates 16:9 (1816x1024) versions of the casino game-card images that
// are NOT already 16:9 (Roulette is square, Blackjack/Poker are 3:2, Dice
// Duel is portrait). Each output is a blurred-fill composite:
//   * the original image, scaled to COVER the 16:9 canvas and blurred, as
//     the background, and
//   * the original image, scaled to CONTAIN the canvas, composited on top.
// Result: the whole original image stays visible (nothing cropped), no hard
// letterbox bars, and it matches the neon-casino look of the other cards.
//
// Usage: node scripts/generate-16x9-card-images.mjs
// Output: src/images/{roulette,blackjack,poker}-card.webp (16:9)

import sharp from "sharp";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const IMG_DIR = join(root, "src/images");

const W = 1816; // same as the user's 16:9 PNGs
const H = 1024;

const jobs = [
  { src: "roulette.webp", out: "roulette-card.webp" },
  { src: "blackjack-div.webp", out: "blackjack-card.webp" },
  { src: "poker div image.webp", out: "poker-card.webp" },
];

async function makeCard(srcFile, outFile) {
  const srcPath = join(IMG_DIR, srcFile);
  const outPath = join(IMG_DIR, outFile);

  const original = await sharp(srcPath).toBuffer();

  // Background: cover + heavy blur + slightly darkened for text contrast.
  const bg = await sharp(original)
    .resize({ width: W, height: H, fit: "cover" })
    .modulate({ brightness: 0.65 })
    .blur(60)
    .toBuffer();

  // Foreground: full original, contained (no crop).
  const fg = await sharp(original)
    .resize({ width: W, height: H, fit: "contain" })
    .toBuffer();

  await sharp(bg)
    .composite([{ input: fg, gravity: "center" }])
    .webp({ quality: 90 })
    .toFile(outPath);

  const meta = await sharp(outPath).metadata();
  const bytes = (await sharp(outPath).toBuffer()).length;
  console.log(
    `${outFile}  ${meta.width}x${meta.height}  ${(bytes / 1024).toFixed(1)} KB`
  );
}

for (const { src, out } of jobs) {
  await makeCard(src, out);
}
console.log("Done.");
