// scripts/generate-pack-images.mjs
//
// Generates the 5 token-pack product images (Starter / Small / Medium /
// Large / Mega) for Stripe. Each is a 1024x1024 PNG on a solid black
// background, built from:
//   * SVG decorations (glows, rings, sparkles, rays, crown) rendered by sharp,
//   * the existing gold "G" logo (public/images/smalllogo.png) composited on
//     top, centered, UNTOUCHED (the file is only read, never modified — it is
//     also used as the app favicon and on card backs, so it must not change).
//
// pack-starter.png = black background + bare G logo (the Starter image).
// The four higher tiers add progressively fancier decorations.
//
// Usage: node scripts/generate-pack-images.mjs
// Output: public/images/pack-starter.png, pack-small.png, pack-medium.png,
//         pack-large.png, pack-mega.png  (all 1024x1024, < 512KB for Stripe)

import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGO_PATH = join(root, "public/images/smalllogo.png");

const SIZE = 1024;
const CX = SIZE / 2;
const CY = SIZE / 2;

// Brand palette (matches the site's neon cyan / gold / pink accents).
const CYAN = "#00e5ff";
const GOLD = "#ffe000";
const YELLOW = "#f5ff3b";
const PINK = "#ff5ec4";
const BLACK = "#000000";

/* ------------------------------------------------------------------ */
/* SVG decoration helpers                                              */
/* ------------------------------------------------------------------ */

function glowCircle(r, color, opacity) {
  return `<radialGradient id="g_${r}_${color.replace(/[^a-z0-9]/gi, "")}_${opacity}">
    <stop offset="0%" stop-color="${color}" stop-opacity="${opacity}"/>
    <stop offset="70%" stop-color="${color}" stop-opacity="${opacity * 0.35}"/>
    <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
  </radialGradient>
  <circle cx="${CX}" cy="${CY}" r="${r}" fill="url(#g_${r}_${color.replace(/[^a-z0-9]/gi, "")}_${opacity})"/>`;
}

function ring(r, width, color, opacity = 1, dashed = false) {
  const dash = dashed ? ` stroke-dasharray="${Math.PI * 2 * r * 0.12} ${Math.PI * 2 * r * 0.05}"` : "";
  return `<circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}"${dash}/>`;
}

function gradientRing(r, width, stops, id) {
  const stopsSvg = stops
    .map(([off, color], i) => `<stop offset="${off * 100}%" stop-color="${color}"/>`)
    .join("");
  return `<linearGradient id="${id}" x1="0%" y1="0%" x2="100%" y2="100%">
    ${stopsSvg}
  </linearGradient>
  <circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="${width}" stroke-linecap="round"/>`;
}

// A 4-point sparkle (concave diamond) at angle `deg` on circle radius `r`.
function sparkle(deg, r, size, color, opacity = 1) {
  const rad = (deg * Math.PI) / 180;
  const x = CX + r * Math.cos(rad);
  const y = CY + r * Math.sin(rad);
  const s = size;
  return `<path d="M ${x} ${y - s} Q ${x + s * 0.28} ${y - s * 0.28} ${x + s} ${y} Q ${x + s * 0.28} ${y + s * 0.28} ${x} ${y + s} Q ${x - s * 0.28} ${y + s * 0.28} ${x - s} ${y} Q ${x - s * 0.28} ${y - s * 0.28} ${x} ${y - s} Z"
    fill="${color}" fill-opacity="${opacity}"/>`;
}

// A small gem (faceted circle) at angle `deg` on circle radius `r`.
function gem(deg, r, size, color) {
  const rad = (deg * Math.PI) / 180;
  const x = CX + r * Math.cos(rad);
  const y = CY + r * Math.sin(rad);
  return `<circle cx="${x}" cy="${y}" r="${size}" fill="${color}"/>
  <circle cx="${x - size * 0.3}" cy="${y - size * 0.3}" r="${size * 0.35}" fill="#ffffff" fill-opacity="0.65"/>`;
}

// Radiant rays behind the logo (rotated wedges, low opacity).
function rays(count, length, width, color, opacity) {
  let out = "";
  for (let i = 0; i < count; i++) {
    const deg = (360 / count) * i;
    out += `<polygon points="${CX},${CY} ${CX + length},${CY - width / 2} ${CX + length},${CY + width / 2}"
      fill="${color}" fill-opacity="${opacity}" transform="rotate(${deg} ${CX} ${CY})"/>`;
  }
  return out;
}

// A simple gold crown centered at (x, y), scaled by s.
function crown(x, y, s) {
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <path d="M -34 14 L -34 -6 L -17 6 L 0 -14 L 17 6 L 34 -6 L 34 14 Z" fill="${GOLD}"/>
    <rect x="-34" y="14" width="68" height="8" rx="3" fill="${GOLD}"/>
    <circle cx="-17" cy="-4" r="3.5" fill="${CYAN}"/>
    <circle cx="0" cy="-12" r="4" fill="${PINK}"/>
    <circle cx="17" cy="-4" r="3.5" fill="${CYAN}"/>
  </g>`;
}

/* ------------------------------------------------------------------ */
/* Tier definitions                                                    */
/* ------------------------------------------------------------------ */

function buildSvg(tier) {
  const parts = [];
  const uid = tier;

  // Solid black background on every image (Starter included).
  parts.push(`<rect x="0" y="0" width="${SIZE}" height="${SIZE}" fill="${BLACK}"/>`);

  if (tier === "starter") {
    // Bare G logo on black — no decorations.
  }

  if (tier === "small") {
    parts.push(glowCircle(300, CYAN, 0.42));
    parts.push(glowCircle(170, "#ffffff", 0.18));
    parts.push(ring(405, 6, CYAN, 0.7));
    parts.push(ring(428, 2, GOLD, 0.5));
  }

  if (tier === "medium") {
    parts.push(glowCircle(330, CYAN, 0.45));
    parts.push(glowCircle(230, GOLD, 0.28));
    parts.push(glowCircle(150, "#ffffff", 0.2));
    parts.push(ring(405, 3, GOLD, 0.85));
    parts.push(gradientRing(430, 10, [[0, CYAN], [0.5, GOLD], [1, CYAN]], `${uid}_ring`));
    for (const deg of [45, 135, 225, 315]) parts.push(sparkle(deg, 375, 26, YELLOW, 0.9));
  }

  if (tier === "large") {
    parts.push(glowCircle(360, CYAN, 0.4));
    parts.push(glowCircle(270, GOLD, 0.3));
    parts.push(glowCircle(180, PINK, 0.22));
    parts.push(glowCircle(120, "#ffffff", 0.22));
    parts.push(ring(398, 3, "#ffffff", 0.75, true));
    parts.push(gradientRing(428, 12, [[0, CYAN], [0.28, CYAN], [0.5, YELLOW], [0.72, PINK], [1, CYAN]], `${uid}_ring`));
    parts.push(ring(456, 2, GOLD, 0.7));
    for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) parts.push(sparkle(deg, 368, 22, YELLOW, 0.85));
  }

  if (tier === "mega") {
    parts.push(rays(16, 430, 90, GOLD, 0.08));
    parts.push(rays(16, 430, 90, PINK, 0.05));
    parts.push(glowCircle(380, PINK, 0.32));
    parts.push(glowCircle(290, GOLD, 0.35));
    parts.push(glowCircle(200, CYAN, 0.3));
    parts.push(glowCircle(130, "#ffffff", 0.28));
    parts.push(ring(390, 3, "#ffffff", 0.8, true));
    parts.push(gradientRing(420, 16, [[0, CYAN], [0.25, CYAN], [0.45, YELLOW], [0.65, PINK], [0.85, GOLD], [1, CYAN]], `${uid}_ring`));
    parts.push(ring(452, 3, GOLD, 0.85));
    parts.push(crown(CX, 300, 1.15));
    for (const deg of [0, 90, 180, 270]) parts.push(gem(deg, 360, 13, CYAN));
    for (const deg of [45, 135, 225, 315]) parts.push(gem(deg, 360, 13, PINK));
    for (const deg of [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5]) parts.push(sparkle(deg, 300, 18, YELLOW, 0.9));
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
    ${parts.join("\n")}
  </svg>`;
}

/* ------------------------------------------------------------------ */
/* Render + composite the logo                                         */
/* ------------------------------------------------------------------ */

async function render(tier) {
  const svg = Buffer.from(buildSvg(tier));
  const logo = sharp(LOGO_PATH).resize({ width: 620, withoutEnlargement: false });

  const out = join(root, `public/images/pack-${tier}.png`);
  await sharp(svg)
    .composite([{ input: await logo.toBuffer(), gravity: "center" }])
    .png({ compressionLevel: 9 })
    .toFile(out);

  const meta = await sharp(out).metadata();
  const bytes = (await sharp(out).toBuffer()).length;
  console.log(
    `pack-${tier}.png  ${meta.width}x${meta.height}  ${(bytes / 1024).toFixed(1)} KB  ${bytes > 512 * 1024 ? "⚠ OVER 512KB" : "OK"}`
  );
}

for (const tier of ["starter", "small", "medium", "large", "mega"]) {
  await render(tier);
}
console.log("Done. public/images/smalllogo.png is untouched (still the favicon + card backs).");
