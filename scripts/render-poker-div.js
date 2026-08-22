// scripts/render-poker-div.js
//
// Generates src/images/poker-div.png — a casino game-card thumbnail for
// Poker, detailed in the manner of blackjack-div.png: two upright 3D
// playing cards (Ace of Spades overlapping King of Hearts slightly), each
// with a realistic side-view poker chip stack in front, on the
// grynd-master-bg.jpg.
//
// Run: node scripts/render-poker-div.js

const sharp = require("sharp");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src", "images");

const W = 1536;
const H = 864;

const CW = 200; // card width
const CH = 280; // card height

// ── Scene ────────────────────────────────────────────────────────
const FRONT = { cx: 680, cy: 400, rot: 2, face: "aceSpades" };
const BACK = { cx: 852, cy: 400, rot: -2, face: "kingHearts" };
const PILES = [
  { cx: 680, cy: 526, colors: "red", chips: 9 },
  { cx: 852, cy: 526, colors: "blue", chips: 8 },
];

const CHIP_RED = { band: "#c31a2e", slot: "#efefef", groove: "#00000042",
  faceOuter: "#b31529", faceRing: "#f3f3f3", faceInner: "#9c1222", faceDot: "#5c0a12" };
const CHIP_BLUE = { band: "#1e3f97", slot: "#efefef", groove: "#00000042",
  faceOuter: "#1b3a8c", faceRing: "#f3f3f3", faceInner: "#14306f", faceDot: "#0a1a44" };

// ── paths ────────────────────────────────────────────────────────
const SPADE = "M0,-46 C-32,-24 -34,2 -17,18 C-8,25 0,26 0,26 C0,26 8,25 17,18 C34,2 32,-24 0,-46 Z M-4,28 L-1.5,44 L1.5,44 L4,28 Z";
const HEART = "M0,16 C-34,-16 -24,-44 0,-26 C24,-44 34,-16 0,16 Z";
const CROWN = "M-30,-34 L-30,-18 L-22,-26 L-11,-14 L0,-26 L11,-14 L22,-26 L30,-18 L30,-34 Z";

// ── SVG building blocks ──────────────────────────────────────────

// corner index: rank over suit, small and crisp, mirrored at the bottom
function cardIndex(cx, cy, rank, suit, flip) {
  const rot = flip ? ` transform="rotate(180 ${cx} ${cy})"` : "";
  const red = suit === "♥";
  return `
  <g${rot}>
    <text x="${cx}" y="${cy + 11}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="bold" font-size="27" fill="${red ? "#b3122b" : "#1c1f26"}">${rank}</text>
    <path d="${HEART}" transform="translate(${cx} ${cy + 38}) scale(0.215)" fill="${red ? "#c8102e" : "#22262e"}" stroke="${red ? "#7d0a1a" : "#0c0e12"}" stroke-width="11" stroke-linejoin="round"/>
  </g>`;
}

// glossy, faceted ace spade art
function aceSpadeCenter(cx, cy) {
  return `
  <!-- soft cast of the art on the card -->
  <path d="${SPADE}" transform="translate(${cx + 4} ${cy + 7}) scale(1.32)" fill="#000000" opacity="0.14" filter="url(#soft6)"/>
  <!-- spade body -->
  <path d="${SPADE}" transform="translate(${cx} ${cy}) scale(1.32)" fill="url(#spadeBody)"/>
  <path d="${SPADE}" transform="translate(${cx} ${cy}) scale(1.32)" fill="none" stroke="#0b0d11" stroke-width="2.6"/>
  <!-- internal facet sheen (left lobe) -->
  <path d="M-30,-20 C-14,-34 -4,-42 0,-42 C-16,-30 -20,-8 -16,10 L-26,4 C-33,-8 -33,-14 -30,-20 Z" fill="#ffffff" opacity="0.22" transform="translate(${cx} ${cy}) scale(1.32)" filter="url(#soft3)"/>
  <!-- rim light -->
  <path d="${SPADE}" transform="translate(${cx + 1.5} ${cy + 1.5}) scale(1.32)" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="3.5" filter="url(#soft2)"/>
  <!-- glossy kicker -->
  <ellipse cx="${cx - 26}" cy="${cy - 30}" rx="11" ry="20" fill="#ffffff" opacity="0.55" transform="rotate(-20 ${cx - 26} ${cy - 30})" filter="url(#soft4)"/>`;
}

// king of hearts art: crown over a glossy heart + flanking small hearts
function kingHeartsCenter(cx, cy) {
  return `
  <!-- flanking small hearts -->
  <path d="${HEART}" transform="translate(${cx - 66} ${cy + 16}) scale(0.34)" fill="url(#heartBody)" stroke="#5d0713" stroke-width="2"/>
  <path d="${HEART}" transform="translate(${cx + 66} ${cy + 16}) scale(0.34)" fill="url(#heartBody)" stroke="#5d0713" stroke-width="2"/>
  <!-- crown -->
  <path d="${CROWN}" transform="translate(${cx} ${cy - 56}) scale(1.02)" fill="url(#goldBody)" stroke="#7d5a0c" stroke-width="2.2"/>
  <circle cx="${cx - 18}" cy="${cy - 28}" r="3.6" fill="#8a1a2c"/>
  <circle cx="${cx}" cy="${cy - 24}" r="3.6" fill="#1d3f8f"/>
  <circle cx="${cx + 18}" cy="${cy - 28}" r="3.6" fill="#8a1a2c"/>
  <!-- big heart -->
  <path d="${HEART}" transform="translate(${cx} ${cy + 16}) scale(1.26)" fill="url(#heartBody)" stroke="#5d0713" stroke-width="3"/>
  <path d="${HEART}" transform="translate(${cx} ${cy + 16}) scale(1.26)" fill="none" stroke="#ffd9de" stroke-opacity="0.5" stroke-width="4" filter="url(#soft2)"/>
  <ellipse cx="${cx - 20}" cy="${cy - 4}" rx="15" ry="24" fill="#ffffff" opacity="0.45" transform="rotate(-16 ${cx - 20} ${cy - 4})" filter="url(#soft4)"/>
  <path d="M-20,-8 C-12,-28 8,-30 16,-14 C6,-22 -6,-22 -20,-8 Z" fill="#ffffff" opacity="0.18" transform="translate(${cx} ${cy + 16}) scale(1.26)" filter="url(#soft3)"/>`;
}

// one 3D playing card, standing upright
function cardGroup(c, thickness) {
  const x = c.cx - CW / 2;
  const y = c.cy - CH / 2;
  return `
  <g transform="rotate(${c.rot} ${c.cx} ${c.cy})">
    <!-- drop shadow -->
    <rect x="${x + 13}" y="${y + 20}" width="${CW}" height="${CH}" rx="15" fill="#000000" opacity="0.55" filter="url(#soft20)"/>
    <!-- warm bounce under the card -->
    <rect x="${x + 6}" y="${y + CH - 8}" width="${CW - 12}" height="10" rx="5" fill="#000000" opacity="0.28" filter="url(#soft8)"/>

    <!-- card stock -->
    <rect x="${x}" y="${y}" width="${CW}" height="${CH}" rx="14" fill="url(#faceg)" stroke="#bcc4d0" stroke-width="2"/>
    <!-- outer frame line -->
    <rect x="${x + 7}" y="${y + 7}" width="${CW - 14}" height="${CH - 14}" rx="10" fill="none" stroke="#c6cdd8" stroke-width="1.4"/>
    <!-- inner frame line -->
    <rect x="${x + 11}" y="${y + 11}" width="${CW - 22}" height="${CH - 22}" rx="8" fill="none" stroke="#dbe1e9" stroke-width="1"/>
    <!-- corner vignette shading -->
    <ellipse cx="${x + 6}" cy="${y + 8}" rx="34" ry="34" fill="#5c6a80" opacity="0.07" filter="url(#soft12)"/>
    <ellipse cx="${x + CW - 6}" cy="${y + CH - 8}" rx="34" ry="34" fill="#5c6a80" opacity="0.07" filter="url(#soft12)"/>

    <!-- lit top edge -->
    <rect x="${x + 9}" y="${y + 2}" width="${CW - 18}" height="4.5" rx="2.2" fill="#ffffff" opacity="0.95" filter="url(#soft1)"/>
    <!-- lit left edge -->
    <rect x="${x + 2}" y="${y + 9}" width="4.5" height="${CH - 18}" rx="2.2" fill="#ffffff" opacity="0.75" filter="url(#soft1)"/>
    <!-- shaded bottom -->
    <rect x="${x + 9}" y="${y + CH - 8}" width="${CW - 18}" height="4.5" rx="2.2" fill="#0d1830" opacity="0.12" filter="url(#soft3)"/>
    <!-- shaded right -->
    <rect x="${x + CW - 8}" y="${y + 9}" width="4.5" height="${CH - 18}" rx="2.2" fill="#0d1830" opacity="0.10" filter="url(#soft3)"/>

    ${thickness ? `
    <!-- visible card-stock edge (front card) -->
    <rect x="${x + CW - 13}" y="${y + 3}" width="9" height="${CH - 6}" rx="3.5" fill="url(#stockEdge)" stroke="#c2cad6" stroke-width="1"/>
    <rect x="${x + CW - 2.6}" y="${y + 5}" width="2.6" height="${CH - 10}" rx="1.3" fill="#aeb7c5" opacity="0.9"/>` : ""}

    <!-- soft horizontal sheen across the face -->
    <ellipse cx="${c.cx}" cy="${y + CH * 0.4}" rx="${CW * 0.78}" ry="26" fill="#ffffff" opacity="0.18" filter="url(#soft12)"/>

    <!-- corner indices -->
    ${cardIndex(x + 24, y + 30, c.face === "aceSpades" ? "A" : "K", c.face === "aceSpades" ? "♠" : "♥", false)}
    ${cardIndex(x + CW - 24, y + CH - 30, c.face === "aceSpades" ? "A" : "K", c.face === "aceSpades" ? "♠" : "♥", true)}

    <!-- center art -->
    ${c.face === "aceSpades" ? aceSpadeCenter(c.cx, y + CH * 0.55) : kingHeartsCenter(c.cx, y + CH * 0.55)}
  </g>`;
}

// side-view chip stack: receding rim bands with white edge spots,
// groove lines, cylindrical shading, elliptical face on the top chip
function chipPile(p) {
  const set = p.colors === "red" ? CHIP_RED : CHIP_BLUE;
  const cx = p.cx;
  const BAND_H = 11;
  const N = p.chips;
  const baseY = p.cy + 42; // bottom of the front (lowest) chip rim
  const topY = baseY - N * BAND_H;

  let bands = "";
  for (let i = 0; i < N; i++) {
    // perspective: chips recede toward the top (narrower, shifted right)
    const frac = (N - 1 - i) / (N - 1); // 1 = front (bottom)
    const halfW = 62 + frac * 14; // front 76px half-width → back 62
    const yBand = baseY - (i + 1) * BAND_H;
    const xOff = (1 - frac) * 5; // back chips shift right a touch
    bands += `
    <rect x="${cx - halfW + xOff}" y="${yBand}" width="${halfW * 2}" height="${BAND_H}" rx="4.5" fill="${set.band}"/>
    <!-- white edge spots -->
    <rect x="${cx - halfW + xOff + halfW * 0.16}" y="${yBand + 1.4}" width="9" height="${BAND_H - 2.8}" rx="3" fill="${set.slot}"/>
    <rect x="${cx - halfW + xOff + halfW * 0.5 - 4.5}" y="${yBand + 1.4}" width="9" height="${BAND_H - 2.8}" rx="3" fill="${set.slot}"/>
    <rect x="${cx + halfW + xOff - halfW * 0.66}" y="${yBand + 1.4}" width="9" height="${BAND_H - 2.8}" rx="3" fill="${set.slot}"/>
    <!-- groove line between chips -->
    <rect x="${cx - halfW + xOff + 2}" y="${yBand + BAND_H - 1.6}" width="${halfW * 2 - 4}" height="1.6" rx="0.8" fill="${set.groove}"/>`;
  }

  return `
  <g>
    <!-- pile shadow -->
    <ellipse cx="${cx + 7}" cy="${baseY + 12}" rx="${76 * 1.22}" ry="13" fill="#000000" opacity="0.55" filter="url(#soft12)"/>
    <!-- stack rim column -->
    ${bands}
    <!-- cylindrical shading (dark flanks, lit core) -->
    <rect x="${cx - 84}" y="${topY - 4}" width="168" height="${baseY - topY + 12}" rx="14" fill="url(#cylShade)" opacity="0.5" filter="url(#soft8)"/>
    <!-- front-left highlight -->
    <rect x="${cx - 82}" y="${topY - 2}" width="26" height="${baseY - topY + 6}" rx="10" fill="#ffffff" opacity="0.10" filter="url(#soft6)"/>
    <!-- top chip face (seen at a low angle) -->
    <ellipse cx="${cx + 3}" cy="${topY - 4}" rx="60" ry="12.5" fill="${set.faceOuter}"/>
    <ellipse cx="${cx + 3}" cy="${topY - 4}" rx="51" ry="10.5" fill="${set.faceRing}"/>
    <ellipse cx="${cx + 3}" cy="${topY - 4}" rx="33" ry="6.8" fill="${set.faceInner}"/>
    <ellipse cx="${cx + 3}" cy="${topY - 4}" rx="11" ry="2.6" fill="${set.faceDot}"/>
    <ellipse cx="${cx - 12}" cy="${topY - 8}" rx="20" ry="4" fill="#ffffff" opacity="0.5" filter="url(#soft2)"/>
  </g>`;
}

function buildSvg() {
  const frontX = FRONT.cx - CW / 2;
  const frontY = FRONT.cy - CH / 2;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <filter id="soft1"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="1"/></filter>
    <filter id="soft2"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="2"/></filter>
    <filter id="soft3"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3"/></filter>
    <filter id="soft4"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="soft6"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="soft8"  x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="8"/></filter>
    <filter id="soft10" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="10"/></filter>
    <filter id="soft12" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="12"/></filter>
    <filter id="soft20" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="20"/></filter>

    <linearGradient id="faceg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="62%" stop-color="#f4f6f9"/>
      <stop offset="100%" stop-color="#e4e8ee"/>
    </linearGradient>

    <linearGradient id="stockEdge" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#f4f6f9"/>
      <stop offset="100%" stop-color="#c7cfda"/>
    </linearGradient>

    <linearGradient id="cylShade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.45"/>
      <stop offset="28%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="72%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.5"/>
    </linearGradient>

    <linearGradient id="spadeBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#4c5462"/>
      <stop offset="42%" stop-color="#1f2229"/>
      <stop offset="100%" stop-color="#090b0f"/>
    </linearGradient>

    <linearGradient id="heartBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e8455a"/>
      <stop offset="55%" stop-color="#c21d34"/>
      <stop offset="100%" stop-color="#931226"/>
    </linearGradient>

    <linearGradient id="goldBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffe89a"/>
      <stop offset="45%" stop-color="#f2b62c"/>
      <stop offset="100%" stop-color="#a97a10"/>
    </linearGradient>
  </defs>

  <!-- back card -->
  ${cardGroup(BACK, false)}
  <!-- cast shadow of the front card onto the back card -->
  <rect x="${FRONT.cx + CW / 2 - 4}" y="${frontY + 8}" width="70" height="${CH - 16}" rx="12" fill="#000000" opacity="0.34" filter="url(#soft10)"/>
  <!-- front card -->
  ${cardGroup(FRONT, true)}

  ${PILES.map(chipPile).join("")}
</svg>`;
}

(async () => {
  const bg = sharp(path.join(SRC, "grynd-master-bg.jpg")).resize(W, H, { fit: "fill" });
  const overlay = await sharp(Buffer.from(buildSvg())).png().toBuffer();
  await bg
    .composite([{ input: overlay, top: 0, left: 0 }])
    .png({ compressionLevel: 9, palette: true })
    .toFile(path.join(SRC, "poker-div.png"));
  console.log("wrote src/images/poker-div.png");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});