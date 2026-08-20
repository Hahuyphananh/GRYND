// scripts/render-memory-grid-div.js
//
// Generates src/images/memory-grid-div.png — a casino game-card thumbnail
// for Memory Grid. Four 3D tiles (same tile model as the mines image:
// extruded slab + cyan neon border) "fly" at random angles, scattered
// around the center; every tile carries the goonbet logo face exactly
// like the real memory-grid game. Blue/cyan neon throughout — no red.
//
// Run: node scripts/render-memory-grid-div.js

const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src", "images");

const W = 1536;
const H = 864; // 16:9 — same aspect as goonbet-master-bg.jpg (1024x572)

const S = 280; // tile size

// ── Flying tile placements — pulled toward the center while keeping each
// tile's relative position and tilt (arrangement shape preserved, minor
// corner overlaps read as flying depth layers) ──────────────────────
const TILES = [
  { cx: 605, cy: 305, rot: -15 },
  { cx: 975, cy: 345, rot: 17 },
  { cx: 615, cy: 585, rot: 10 },
  { cx: 935, cy: 610, rot: -8 },
];

// goonbet logo: crop out ONLY the G icon from logo1.png (cluster at
// x 94-223, y 132-274 — the wordmark strip x 231-519 is dropped).
// Small pad so the icon's edges aren't squished.
const LOGO_SRC = path.join(SRC, "logo1.png");
const ICON_CROP = { left: 90, top: 128, width: 138, height: 150 };

// ── SVG building blocks ─────────────────────────────────────────

// one flying tile: 3D extruded slab, cyan neon border, goonbet logo face
function tileGroup(t, logoB64) {
  const gid = `rt${Math.round(t.cx)}${Math.round(t.cy)}`;
  // G icon takes ~72% of the tile — big and readable, aspect preserved
  const lw = S * 0.72;
  const lh = (lw * ICON_CROP.height) / ICON_CROP.width;
  const lx = t.cx - lw / 2;
  const ly = t.cy - lh / 2;
  const x = t.cx - S / 2;
  const y = t.cy - S / 2;
  return `
  <g transform="rotate(${t.rot} ${t.cx} ${t.cy})">
    <!-- soft drop shadow slab (light from top-left → shadow bottom-right) -->
    <rect x="${x + 24}" y="${y + 30}" width="${S}" height="${S}" rx="21" fill="#000000" opacity="0.55" filter="url(#soft22)"/>
    <!-- neon halo spilling out around the tile (cyan only) -->
    <rect x="${x - 12}" y="${y - 12}" width="${S + 24}" height="${S + 24}" rx="34" fill="#22d3ee" opacity="0.30" filter="url(#soft30)"/>
    <!-- neon aura rim -->
    <rect x="${x}" y="${y}" width="${S}" height="${S}" rx="21" fill="none" stroke="#22d3ee" stroke-opacity="0.6" stroke-width="10" filter="url(#soft10)"/>
    <!-- inner border tint -->
    <rect x="${x}" y="${y}" width="${S}" height="${S}" rx="21" fill="none" stroke="#22d3ee" stroke-opacity="0.35" stroke-width="6" filter="url(#soft6)"/>
    <!-- crisp neon edge -->
    <rect x="${x}" y="${y}" width="${S}" height="${S}" rx="21" fill="none" stroke="#22d3ee" stroke-opacity="1" stroke-width="3" filter="url(#soft1)"/>
    <!-- solid extrusion (visible thickness, bottom-right) -->
    <rect x="${x + 14}" y="${y + 18}" width="${S}" height="${S}" rx="21" fill="#0a1f45" stroke="#12305f" stroke-width="3"/>
    <!-- top face -->
    <rect x="${x}" y="${y}" width="${S}" height="${S}" rx="21" fill="url(#${gid})" stroke="#22d3ee" stroke-opacity="0.8" stroke-width="3"/>
    <!-- inner bevel -->
    <rect x="${x + 8}" y="${y + 8}" width="${S - 16}" height="${S - 16}" rx="15" fill="none" stroke="#ffffff" stroke-opacity="0.09" stroke-width="2"/>
    <!-- top gloss -->
    <rect x="${x + 11}" y="${y + 11}" width="${S - 22}" height="${(S - 22) * 0.42}" rx="13" fill="#ffffff" opacity="0.06" filter="url(#soft8)"/>
    <!-- warm amber light the logo casts onto the tile face (like the game's glow) -->
    <circle cx="${t.cx}" cy="${t.cy}" r="150" fill="#ffd54a" opacity="0.10" filter="url(#soft40)"/>
    <!-- goonbet G icon face (wordmark removed, fills the tile) -->
    <image href="data:image/png;base64,${logoB64}" x="${lx}" y="${ly}" width="${lw}" height="${lh}" preserveAspectRatio="xMidYMid meet"/>
  </g>`;
}

function buildSvg(logoB64) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <filter id="soft1"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="1"/></filter>
    <filter id="soft6"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="soft8"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="8"/></filter>
    <filter id="soft10" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="10"/></filter>
    <filter id="soft22" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="soft30" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="30"/></filter>
    <filter id="soft40" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="40"/></filter>
    ${TILES.map(
      (t) => `
    <linearGradient id="rt${Math.round(t.cx)}${Math.round(t.cy)}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#143b70"/>
      <stop offset="55%" stop-color="#0a2350"/>
      <stop offset="100%" stop-color="#061a3c"/>
    </linearGradient>`
    ).join("")}
  </defs>

  ${TILES.map((t) => tileGroup(t, logoB64)).join("")}
</svg>`;
}

(async () => {
  const bg = sharp(path.join(SRC, "goonbet-master-bg.jpg")).resize(W, H, {
    fit: "fill",
  });
  // crop the wordmark out of logo1.png → just the G icon, as base64
  const icon = await sharp(LOGO_SRC)
    .extract(ICON_CROP)
    .png()
    .toBuffer();
  const overlay = await sharp(Buffer.from(buildSvg(icon.toString("base64"))))
    .png()
    .toBuffer();
  await bg
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png({ compressionLevel: 9, palette: true })
    .toFile(path.join(SRC, "memory-grid-div.png"));
  console.log("wrote src/images/memory-grid-div.png");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});