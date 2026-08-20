// scripts/render-mines-div.js
//
// Generates src/images/mines-div.png — a casino game-card thumbnail for
// Mines. A tilted 2x2 board of realistic 3D tiles (three with a gem in
// the middle, one — tinted red — with a bomb) composite-rendered over
// the provided goonbet-master-bg.jpg.
//
// Run: node scripts/render-mines-div.js

const sharp = require("sharp");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src", "images");

const W = 1536;
const H = 864; // 16:9 — same aspect as goonbet-master-bg.jpg (1024x572)

// ── Board layout ────────────────────────────────────────────────
const X0 = 455;
const Y0 = 119;
const S = 300;
const GAP = 26;

const TILES = [
  { x: X0, y: Y0, kind: "gem" }, // top-left
  { x: X0 + S + GAP, y: Y0, kind: "gem" }, // top-right
  { x: X0, y: Y0 + S + GAP, kind: "gem" }, // bottom-left
  { x: X0 + S + GAP, y: Y0 + S + GAP, kind: "bomb" }, // bottom-right
];

// ── SVG building blocks ─────────────────────────────────────────

// front-view brilliant-cut gem, centered slightly low so the visual mass
// (a gem reads heavier at the bottom) looks centered inside the tile.
function gemSvg(cx0, cy0) {
  const dy = 12; // optical-centering nudge
  const cx = cx0;
  const cy = cy0 + dy;
  const g = (x, y) => `${cx + x},${cy + y}`;
  return `
  <!-- soft glow behind the gem (gentle) -->
  <circle cx="${cx}" cy="${cy}" r="96" fill="#33d7ff" opacity="0.07" filter="url(#soft26)"/>
  <!-- table (top face) -->
  <polygon points="${g(-42,-48)} ${g(42,-48)} ${g(50,-10)} ${g(-50,-10)}" fill="url(#tableg)"/>
  <!-- crown left + right -->
  <polygon points="${g(-42,-48)} ${g(-50,-10)} ${g(-74,16)} ${g(-70,-14)}" fill="#9fd8f5"/>
  <polygon points="${g(42,-48)} ${g(50,-10)} ${g(74,16)} ${g(70,-14)}" fill="#5aa8d4"/>
  <!-- girdle band -->
  <polygon points="${g(-74,16)} ${g(74,16)} ${g(70,26)} ${g(-70,26)}" fill="#2c5c82"/>
  <!-- pavilion (bottom) left / center / right -->
  <polygon points="${g(-74,16)} ${g(-70,26)} ${g(0,90)}" fill="#82ccec"/>
  <polygon points="${g(74,16)} ${g(70,26)} ${g(0,90)}" fill="#347fae"/>
  <polygon points="${g(-30,26)} ${g(30,26)} ${g(0,90)}" fill="#4aa3cf"/>
  <!-- facet seams (subtle) -->
  <polygon points="${g(-42,-48)} ${g(42,-48)} ${g(74,16)} ${g(-74,16)}" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="1"/>
  <line x1="${g(-70,-14)}" y1="${g(70,-14)}" x2="${g(0,90)}" y2="${g(0,90)}" stroke="#ffffff" stroke-opacity="0.12" stroke-width="1"/>
  <!-- neon outline: blue glow hugging the gem silhouette -->
  <polygon points="${g(-42,-48)} ${g(42,-48)} ${g(74,16)} ${g(0,90)} ${g(-74,16)}" fill="none" stroke="#35d7ff" stroke-opacity="0.65" stroke-width="7" filter="url(#soft6)"/>
  <polygon points="${g(-42,-48)} ${g(42,-48)} ${g(74,16)} ${g(0,90)} ${g(-74,16)}" fill="none" stroke="#7fe6ff" stroke-opacity="0.95" stroke-width="2" filter="url(#soft1)"/>
  <!-- soft white fire sweep -->
  <ellipse cx="${cx - 15}" cy="${cy - 33}" rx="24" ry="11" fill="#ffffff" opacity="0.5" filter="url(#soft4)"/>
  <!-- small sparkle twinkle -->
  <g transform="rotate(45 ${cx + 32} ${cy - 38})">
    <rect x="${cx + 28}" y="${cy - 52}" width="7" height="28" rx="3.5" fill="#ffffff" opacity="0.9" filter="url(#soft2)"/>
  </g>
  <rect x="${cx + 32}" y="${cy - 40}" width="28" height="7" rx="3.5" fill="#ffffff" opacity="0.9" transform="rotate(45 ${cx + 32} ${cy - 38})" filter="url(#soft2)"/>
  <circle cx="${cx + 32}" cy="${cy - 38}" r="4" fill="#ffffff" opacity="0.9"/>`;
}

// realistic bomb, centered in the tile (sphere + cap + fuse + spark all
// comfortably inside the 300px tile), with softened light/shadow.
function bombSvg(cx0, cy0) {
  const cx = cx0;
  const cy = cy0 + 6;
  const R = 70;
  return `
  <!-- menace halo (matches the red tile, gentle) -->
  <circle cx="${cx}" cy="${cy}" r="${R * 1.55}" fill="#dc2626" opacity="0.08" filter="url(#soft30)"/>
  <!-- soft contact shadow -->
  <ellipse cx="${cx + 8}" cy="${cy + R + 14}" rx="${R * 0.75}" ry="16" fill="#000000" opacity="0.45" filter="url(#soft14)"/>
  <!-- fuse spark glow -->
  <circle cx="${cx + 21}" cy="${cy - R - 24}" r="22" fill="#ffb300" opacity="0.3" filter="url(#soft12)"/>
  <circle cx="${cx + 21}" cy="${cy - R - 24}" r="10" fill="#fff3cf" filter="url(#soft3)"/>
  <!-- burning spark -->
  <circle cx="${cx + 21}" cy="${cy - R - 24}" r="7" fill="#fffbe0"/>
  <!-- stray sparks -->
  <circle cx="${cx + 36}" cy="${cy - R - 34}" r="2.4" fill="#ffe9a0" filter="url(#soft2)"/>
  <circle cx="${cx + 10}" cy="${cy - R - 40}" r="2" fill="#ffe9a0" filter="url(#soft2)"/>
  <!-- fuse wire -->
  <path d="M ${cx + 4} ${cy - R + 8} C ${cx + 13} ${cy - R - 6} ${cx + 17} ${cy - R - 12} ${cx + 21} ${cy - R - 20}" fill="none" stroke="#caa04f" stroke-width="6" stroke-linecap="round"/>
  <path d="M ${cx + 4} ${cy - R + 8} C ${cx + 13} ${cy - R - 6} ${cx + 17} ${cy - R - 12} ${cx + 21} ${cy - R - 20}" fill="none" stroke="#f0e2b0" stroke-width="2.6" stroke-linecap="round"/>
  <!-- fuse holder cap -->
  <ellipse cx="${cx}" cy="${cy - R + 4}" rx="13" ry="6" fill="#dfe6ec" stroke="#8f99a6" stroke-width="1.6"/>
  <rect x="${cx - 12}" y="${cy - R - 6}" width="24" height="10" rx="5" fill="url(#metalg)"/>
  <!-- bomb body -->
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#bombg)"/>
  <!-- neon outline: red glow hugging the bomb silhouette -->
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#ff5252" stroke-opacity="0.65" stroke-width="9" filter="url(#soft6)"/>
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#ff8a8a" stroke-opacity="0.95" stroke-width="2.5" filter="url(#soft1)"/>
  <!-- soft rounding light on the upper-left -->
  <ellipse cx="${cx - R * 0.38}" cy="${cy - R * 0.42}" rx="${R * 0.5}" ry="${R * 0.34}" fill="#ffffff" opacity="0.10" filter="url(#soft10)"/>
  <!-- cool rim catching board light, bottom-right -->
  <path d="M ${cx - R * 0.72} ${cy + R * 0.62} A ${R * 0.8} ${R * 0.8} 0 0 0 ${cx + R * 0.7} ${cy + R * 0.64}" fill="none" stroke="#7d8a9a" stroke-opacity="0.35" stroke-width="3" filter="url(#soft2)"/>
  <!-- top-left sheen -->
  <ellipse cx="${cx - 24}" cy="${cy - 30}" rx="20" ry="13" fill="#ffffff" opacity="0.5" filter="url(#soft5)"/>
  <circle cx="${cx - 34}" cy="${cy - 38}" r="4.5" fill="#ffffff" opacity="0.7" filter="url(#soft2)"/>`;
}

// one 3D tile: extruded rounded slab + contents (red theme for the bomb)
function tileGroup(t) {
  const cx = t.x + S / 2;
  const cy = t.y + S / 2;
  const inner = t.kind === "gem" ? gemSvg(cx, cy) : bombSvg(cx, cy);
  const isBomb = t.kind === "bomb";
  const faceFill = isBomb ? "url(#tilegRed)" : "url(#tileg)";
  const faceStroke = isBomb ? "#ff4d4d" : "#22d3ee";
  const extFill = isBomb ? "#4d0e0e" : "#0a1f45";
  const extStroke = isBomb ? "#6b1717" : "#12305f";
  const glow = isBomb ? "#ff4d4d" : "#22d3ee";
  return `
  <g>
    <!-- soft drop shadow slab (light from top-left → shadow bottom-right) -->
    <rect x="${t.x + 26}" y="${t.y + 34}" width="${S}" height="${S}" rx="22" fill="#000000" opacity="0.55" filter="url(#soft22)"/>
    <!-- neon halo spilling out around the tile -->
    <rect x="${t.x - 12}" y="${t.y - 12}" width="${S + 24}" height="${S + 24}" rx="36" fill="${glow}" opacity="0.30" filter="url(#soft30)"/>
    <!-- neon aura rim -->
    <rect x="${t.x}" y="${t.y}" width="${S}" height="${S}" rx="22" fill="none" stroke="${glow}" stroke-opacity="0.6" stroke-width="10" filter="url(#soft10)"/>
    <!-- inner border tint -->
    <rect x="${t.x}" y="${t.y}" width="${S}" height="${S}" rx="22" fill="none" stroke="${glow}" stroke-opacity="0.35" stroke-width="6" filter="url(#soft6)"/>
    <!-- crisp neon edge -->
    <rect x="${t.x}" y="${t.y}" width="${S}" height="${S}" rx="22" fill="none" stroke="${glow}" stroke-opacity="1" stroke-width="3" filter="url(#soft1)"/>
    <!-- solid extrusion (visible thickness, bottom-right) -->
    <rect x="${t.x + 15}" y="${t.y + 19}" width="${S}" height="${S}" rx="22" fill="${extFill}" stroke="${extStroke}" stroke-width="3"/>
    <!-- top face -->
    <rect x="${t.x}" y="${t.y}" width="${S}" height="${S}" rx="22" fill="${faceFill}" stroke="${faceStroke}" stroke-opacity="0.8" stroke-width="3"/>
    <!-- inner bevel -->
    <rect x="${t.x + 9}" y="${t.y + 9}" width="${S - 18}" height="${S - 18}" rx="16" fill="none" stroke="#ffffff" stroke-opacity="0.09" stroke-width="2"/>
    <!-- top gloss -->
    <rect x="${t.x + 12}" y="${t.y + 12}" width="${S - 24}" height="${(S - 24) * 0.42}" rx="14" fill="#ffffff" opacity="0.06" filter="url(#soft8)"/>
    ${inner}
  </g>`;
}

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <filter id="soft1"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="1"/></filter>
    <filter id="soft2"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="2"/></filter>
    <filter id="soft3"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3"/></filter>
    <filter id="soft4"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="soft5"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="soft8"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="8"/></filter>
    <filter id="soft10" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="10"/></filter>
    <filter id="soft12" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="12"/></filter>
    <filter id="soft14" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="soft22" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="soft26" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="26"/></filter>
    <filter id="soft30" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="30"/></filter>

    <linearGradient id="tileg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#143b70"/>
      <stop offset="55%" stop-color="#0a2350"/>
      <stop offset="100%" stop-color="#061a3c"/>
    </linearGradient>

    <linearGradient id="tilegRed" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#8f1d1d"/>
      <stop offset="55%" stop-color="#5e1111"/>
      <stop offset="100%" stop-color="#3f0b0b"/>
    </linearGradient>

    <linearGradient id="tableg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#d7f2ff"/>
    </linearGradient>

    <radialGradient id="bombg" cx="33%" cy="28%" r="95%">
      <stop offset="0%" stop-color="#bcc5cf"/>
      <stop offset="20%" stop-color="#8a93a0"/>
      <stop offset="50%" stop-color="#5d6673"/>
      <stop offset="78%" stop-color="#333a44"/>
      <stop offset="100%" stop-color="#1c2129"/>
    </radialGradient>

    <linearGradient id="metalg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#eef3f7"/>
      <stop offset="100%" stop-color="#7e8794"/>
    </linearGradient>
  </defs>

  <!-- grounding shadow under the whole tilted board -->
  <ellipse cx="768" cy="560" rx="470" ry="230" fill="#000000" opacity="0.35" filter="url(#soft30)"/>

  <!-- tilted board: angled sideways to emphasize the 3D + shadows -->
  <g transform="translate(768 432) rotate(-11) skewX(-7) translate(-768 -432)">
    ${TILES.map(tileGroup).join("")}
  </g>
</svg>`;

(async () => {
  const bg = sharp(path.join(SRC, "goonbet-master-bg.jpg")).resize(W, H, {
    fit: "fill",
  });
  const overlay = await sharp(Buffer.from(svg)).png().toBuffer();
  await bg
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png({ compressionLevel: 9, palette: true })
    .toFile(path.join(SRC, "mines-div.png"));
  console.log("wrote src/images/mines-div.png");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});