// scripts/render-plinko-div.js
//
// Generates src/images/plinko-div.png — a casino game-card thumbnail for
// Plinko. It composite-renders 6 chrome plinko pins plus a large glowing
// ball (with motion streaks) over the provided goonbet-master-bg.jpg.
//
// The background image is used untouched (only resized to fill the frame),
// matching the "master bg" look of blackjack-div.png / roulette div image.
//
// Run: node scripts/render-plinko-div.js

const sharp = require("sharp");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src", "images");

const W = 1536;
const H = 864; // 16:9 — same aspect as goonbet-master-bg.jpg (1024x572)

// ── Scene layout ───────────────────────────────────────────────
// The camera is zoomed in on the fall: the ball dominates the center,
// six pegs frame it (background pegs already "passed", foreground pegs
// the ball is diving into).
const BALL = { cx: 768, cy: 312, r: 90 };

const PINS = [
  // background pegs the ball already bounced off (out of focus, darker)
  { cx: 430, cy: 220, r: 46, blur: 3, dim: 0.82, bg: true },
  { cx: 1065, cy: 255, r: 44, blur: 3, dim: 0.85, bg: true },
  // mid pegs beside the fall (sharp foreground)
  { cx: 560, cy: 468, r: 55, blur: 0, dim: 1, bg: false },
  { cx: 992, cy: 478, r: 55, blur: 0, dim: 1, bg: false },
  // the peg the ball is about to strike (focal point)
  { cx: 768, cy: 552, r: 60, blur: 0, dim: 1, bg: false },
  // lower-right peg, cut by the frame → reinforces the "zoomed in" feel
  { cx: 1140, cy: 648, r: 54, blur: 0, dim: 1, bg: false },
];

// ── SVG building blocks ─────────────────────────────────────────

// gradient definition for a chrome pin — emitted inside <defs>
function chromePinGrad(cx, cy) {
  const gid = `pg${Math.round(cx)}${Math.round(cy)}`;
  return `
    <radialGradient id="${gid}" cx="32%" cy="26%" r="90%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="18%" stop-color="#eaf1ff"/>
      <stop offset="42%" stop-color="#a9bcd9"/>
      <stop offset="66%" stop-color="#43547d"/>
      <stop offset="84%" stop-color="#1a2447"/>
      <stop offset="100%" stop-color="#0b1126"/>
    </radialGradient>`;
}

// group drawing a chrome pin — emitted in the SVG body
function chromePin(cx, cy, r, blur, dim) {
  const f = blur > 0 ? ` filter="url(#b${blur})"` : "";
  const gid = `pg${Math.round(cx)}${Math.round(cy)}`;
  return `
  <g opacity="${dim}" ${f}>
    <!-- soft contact shadow on the board -->
    <ellipse cx="${cx + r * 0.12}" cy="${cy + r * 0.98}" rx="${r * 0.52}" ry="${r * 0.22}" fill="#000000" opacity="0.5" filter="url(#soft20)"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${gid})"/>
    <!-- crisp bright rim -->
    <circle cx="${cx}" cy="${cy}" r="${r - 0.6}" fill="none" stroke="#dbeaff" stroke-opacity="0.28" stroke-width="${Math.max(1.4, r * 0.035)}"/>
    <!-- top-left specular -->
    <ellipse cx="${cx - r * 0.3}" cy="${cy - r * 0.34}" rx="${r * 0.42}" ry="${r * 0.3}" fill="#ffffff" opacity="0.55" filter="url(#soft6)"/>
    <ellipse cx="${cx - r * 0.52}" cy="${cy - r * 0.56}" rx="${r * 0.12}" ry="${r * 0.09}" fill="#ffffff" opacity="0.9" filter="url(#soft3)"/>
    <!-- cool cyan bounce light, bottom edge -->
    <ellipse cx="${cx + r * 0.28}" cy="${cy + r * 0.42}" rx="${r * 0.34}" ry="${r * 0.2}" fill="#38d9ff" opacity="0.22" filter="url(#soft8)"/>
    <!-- subtle cyan neon halo -->
    <circle cx="${cx}" cy="${cy}" r="${r * 1.16}" fill="none" stroke="#38d9ff" stroke-opacity="0.16" stroke-width="${r * 0.16}" filter="url(#soft12)"/>
  </g>`;
}

function fallingBall() {
  const { cx, cy, r } = BALL;
  return `
  <defs>
    <radialGradient id="ballg" cx="33%" cy="27%" r="92%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="10%" stop-color="#fff1bd"/>
      <stop offset="30%" stop-color="#ffc25e"/>
      <stop offset="55%" stop-color="#ff7a12"/>
      <stop offset="78%" stop-color="#e23c00"/>
      <stop offset="100%" stop-color="#8a1200"/>
    </radialGradient>
    <linearGradient id="streakg" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="#ffd27b" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#ff7022" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- motion glow + halo (screen-ish over dark bg) -->
  <circle cx="${cx}" cy="${cy}" r="${r * 2.5}" fill="#ff3d00" opacity="0.30" filter="url(#soft46)"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 1.55}" fill="#ff8020" opacity="0.42" filter="url(#soft24)"/>

  <!-- motion streaks: lines racing upward as the ball falls downward -->
  <g opacity="1">
    <rect x="${cx - r * 0.16}" y="${cy - r * 2.6}" width="${r * 0.16}" height="${r * 1.35}" rx="${r * 0.08}" fill="url(#streakg)" filter="url(#soft5)"/>
    <rect x="${cx - r * 0.55}" y="${cy - r * 2.35}" width="${r * 0.1}" height="${r * 1.1}" rx="${r * 0.05}" fill="url(#streakg)" opacity="0.8" filter="url(#soft4)"/>
    <rect x="${cx + r * 0.42}" y="${cy - r * 2.25}" width="${r * 0.1}" height="${r * 1.05}" rx="${r * 0.05}" fill="url(#streakg)" opacity="0.8" filter="url(#soft4)"/>
    <rect x="${cx + r * 0.85}" y="${cy - r * 1.95}" width="${r * 0.07}" height="${r * 0.85}" rx="${r * 0.035}" fill="url(#streakg)" opacity="0.6" filter="url(#soft3)"/>
    <rect x="${cx - r * 0.98}" y="${cy - r * 1.8}" width="${r * 0.07}" height="${r * 0.8}" rx="${r * 0.035}" fill="url(#streakg)" opacity="0.6" filter="url(#soft3)"/>
  </g>

  <!-- faint ghost trail of the ball (speed feel) -->
  <circle cx="${cx}" cy="${cy - r * 1.05}" r="${r * 0.82}" fill="#ff6a17" opacity="0.22" filter="url(#soft18)"/>
  <circle cx="${cx}" cy="${cy - r * 0.5}" r="${r * 0.9}" fill="#ff8a2a" opacity="0.12" filter="url(#soft8)"/>

  <!-- the ball -->
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#ballg)"/>
  <!-- cool cyan ambient rim on the left (picks up casino-blue light) -->
  <path d="M ${cx - r * 0.98} ${cy} A ${r * 0.98} ${r * 0.98} 0 0 1 ${cx} ${cy + r * 0.95}" fill="none" stroke="#8fdffd" stroke-opacity="0.30" stroke-width="${r * 0.07}" filter="url(#soft5)"/>
  <!-- strong hot specular -->
  <ellipse cx="${cx - r * 0.34}" cy="${cy - r * 0.4}" rx="${r * 0.34}" ry="${r * 0.24}" fill="#ffffff" opacity="0.85" filter="url(#soft6)"/>
  <ellipse cx="${cx - r * 0.56}" cy="${cy - r * 0.62}" rx="${r * 0.12}" ry="${r * 0.09}" fill="#ffffff" opacity="0.95" filter="url(#soft2)"/>
  <!-- warm bounce light at the base -->
  <ellipse cx="${cx + r * 0.3}" cy="${cy + r * 0.42}" rx="${r * 0.26}" ry="${r * 0.14}" fill="#ffd9a0" opacity="0.5" filter="url(#soft5)"/>`;
}

const pinGradDefs = PINS.map((p) => chromePinGrad(p.cx, p.cy)).join("");
const pinGroups = PINS.map((p) => chromePin(p.cx, p.cy, p.r, p.blur, p.dim)).join("");

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <filter id="soft2"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="2"/></filter>
    <filter id="soft3"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3"/></filter>
    <filter id="soft4"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="soft5"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="soft6"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="soft8"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="8"/></filter>
    <filter id="soft12" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="12"/></filter>
    <filter id="soft18" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="18"/></filter>
    <filter id="soft20" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="20"/></filter>
    <filter id="soft24" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="24"/></filter>
    <filter id="soft46" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="46"/></filter>
    <filter id="b3" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3"/></filter>
    ${pinGradDefs}
  </defs>
  ${pinGroups}
  ${fallingBall()}
</svg>`;

(async () => {
  // Background: scale 1024x572 → 1536x864 (exact 16:9, no cropping).
  const bg = sharp(path.join(SRC, "goonbet-master-bg.jpg")).resize(W, H, {
    fit: "fill",
  });

  const overlay = await sharp(Buffer.from(svg)).png().toBuffer();

  await bg
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png({ compressionLevel: 9, palette: true })
    .toFile(path.join(SRC, "plinko-div.png"));

  console.log("wrote src/images/plinko-div.png");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
