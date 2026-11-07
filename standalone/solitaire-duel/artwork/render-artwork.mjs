// standalone/solitaire-duel/artwork/render-artwork.mjs
//
// One vector master, every asset a portal asks for.
//
// A submission needs two different kinds of picture:
//
//   1. Files that ship INSIDE the package — the favicon set. They go to
//      `standalone/solitaire-duel/public/`, which Vite copies to the output
//      root, so they are committed here as PNG/ICO/SVG rather than generated
//      during a build. A portal upload must be reproducible with nothing but
//      `npm run build:portal:solitaire`; a build that needs sharp to make its
//      own icon is a build that can fail on someone else's machine.
//
//   2. Files that are uploaded to the portal's FORM, not with the game — the
//      covers. They are written to `dist/portal/artwork/` (next to the package,
//      not inside it) so the game upload stays three files and the covers never
//      count against a review of the build.
//
// Run it with `npm run artwork:portal:solitaire`.
//
// The palette and the motifs come from the game itself: the deep navy board,
// cyan #00e5ff, the magenta opponent bar, the same face cards and the same two
// progress bars the player sees while racing.

import { mkdir, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const REPO = resolve(APP, "..", "..");
const ICON_DIR = join(APP, "public");
const COVER_DIR = join(REPO, "dist", "portal", "artwork");

const FONT = "Segoe UI, Segoe UI Variable Display, Inter, Arial, Helvetica, sans-serif";

const CYAN = "#00e5ff";
const CYAN_SOFT = "#9beaff";
const MAGENTA = "#ff4fd8";
const AMBER = "#f59e0b";
const CARD_RED = "#d81f3a";
const CARD_INK = "#121a26";
const WHITE = "#ffffff";

// Simplified suit marks on a 24-unit grid. Vector, not glyphs, so the render
// does not depend on which fonts happen to exist on the machine doing the build.
const SUITS = {
  spade:
    "M12 2.1C9.3 6 4.2 8.4 4.2 12.2A3.9 3.9 0 0 0 10.4 15c-.2 1.9-1 3.2-2.1 4.1h7.4c-1.1-.9-1.9-2.2-2.1-4.1A3.9 3.9 0 0 0 19.8 12.2C19.8 8.4 14.7 6 12 2.1Z",
  heart:
    "M12 21.3S2.9 15 2.9 9.4A4.9 4.9 0 0 1 12 6.4a4.9 4.9 0 0 1 9.1 3c0 5.6-9.1 11.9-9.1 11.9Z",
  diamond: "M12 2 20.4 12 12 22 3.6 12Z",
  club: "M12 2.2a3.8 3.8 0 0 1 3.3 5.7 3.8 3.8 0 1 1-1.1 6.2c.2 2 .9 3.3 1.9 4.1H7.9c1-.8 1.7-2.1 1.9-4.1a3.8 3.8 0 1 1-1.1-6.2A3.8 3.8 0 0 1 12 2.2Z",
};

const defs = () => `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#0f1936"/>
    <stop offset="52%" stop-color="#070c19"/>
    <stop offset="100%" stop-color="#04070f"/>
  </linearGradient>
  <radialGradient id="halo" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="${CYAN}" stop-opacity="0.26"/>
    <stop offset="52%" stop-color="#2b4cff" stop-opacity="0.12"/>
    <stop offset="100%" stop-color="#04070f" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="warm" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="${MAGENTA}" stop-opacity="0.20"/>
    <stop offset="100%" stop-color="#04070f" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#ffffff"/>
    <stop offset="100%" stop-color="#dbe6f5"/>
  </linearGradient>
  <linearGradient id="back" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#234670"/>
    <stop offset="100%" stop-color="#0d2240"/>
  </linearGradient>
  <linearGradient id="cyanBar" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="${CYAN}"/>
    <stop offset="100%" stop-color="#67e8f9"/>
  </linearGradient>
  <linearGradient id="amberBar" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="${AMBER}"/>
    <stop offset="100%" stop-color="#fbbf24"/>
  </linearGradient>
</defs>`;

function suit(kind, { x, y, size, color }) {
  return `<g transform="translate(${x} ${y}) scale(${size / 24})"><path d="${SUITS[kind]}" fill="${color}"/></g>`;
}

/** A white playing card with a rank and one large suit mark. */
function cardFace({ x, y, w, h, rot = 0, rank = "A", mark = "spade", color = CARD_INK }) {
  const radius = w * 0.08;
  const pip = w * 0.33;
  return `<g transform="translate(${x} ${y}) rotate(${rot})">
    <rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="url(#face)"/>
    <rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="none" stroke="#04070f" stroke-opacity="0.35" stroke-width="${w * 0.012}"/>
    <text x="${w * 0.1}" y="${h * 0.2}" font-family="${FONT}" font-size="${w * 0.2}" font-weight="800" fill="${color}" letter-spacing="0">${rank}</text>
    ${suit(mark, { x: w * 0.5 - pip / 2, y: h * 0.5 - pip / 2, size: pip, color })}
    ${suit(mark, { x: w * 0.5 - pip * 0.34, y: h * 0.82 - pip * 0.34, size: pip * 0.68, color })}
  </g>`;
}

/** The face-down card: navy back, cyan inset frame, no glyphs. */
function cardBack({ x, y, w, h, rot = 0 }) {
  const radius = w * 0.08;
  return `<g transform="translate(${x} ${y}) rotate(${rot})">
    <rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" fill="url(#back)" stroke="#1f3a5f" stroke-width="${w * 0.014}"/>
    <rect x="${w * 0.09}" y="${h * 0.06}" width="${w * 0.82}" height="${h * 0.88}" rx="${radius * 0.5}" fill="none" stroke="${CYAN}" stroke-opacity="0.32" stroke-width="${w * 0.012}"/>
    ${suit("spade", { x: w * 0.5 - w * 0.16, y: h * 0.5 - w * 0.16, size: w * 0.32, color: "#8fd8ea" })}
  </g>`;
}

/** The two race bars the player actually sees in-game. */
function progressBars({ x, y, w, h, rows }) {
  return rows
    .map((row, index) => {
      const top = y + index * h * 5.2;
      return `<g>
        <text x="${x}" y="${top}" font-family="${FONT}" font-size="${h * 1.5}" font-weight="700" fill="${WHITE}" fill-opacity="0.62" letter-spacing="${h * 0.35}">${row.label}</text>
        <rect x="${x}" y="${top + h * 0.9}" width="${w}" height="${h}" rx="${h / 2}" fill="#0f1a30"/>
        <rect x="${x}" y="${top + h * 0.9}" width="${w * row.pct}" height="${h}" rx="${h / 2}" fill="url(#${row.fill})"/>
      </g>`;
    })
    .join("");
}

function wordmark({ x, y, size, anchor = "start", opacity = 0.55 }) {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${FONT}" font-size="${size}" font-weight="900" fill="${CYAN}" fill-opacity="${opacity}" letter-spacing="${size * 0.4}">GRYND</text>`;
}

/** Landscape cover: cards on the left, title and bars on the right. */
function horizontalCover(W, H) {
  // Narrow formats (the 630×500 itch cover) have far less room per character,
  // so the type scales with the WIDTH as well as the height and the long
  // strapline is swapped for the short one.
  const narrow = W < 1000;
  const cardW = W * (narrow ? 0.14 : 0.15);
  const cardH = cardW * 1.4;
  const cardY = H * 0.5 - cardH / 2;
  const cx = W * 0.255;
  const titleSize = Math.min(H * 0.108, W * (narrow ? 0.068 : 0.075));
  const textX = W * (narrow ? 0.52 : 0.505);
  const titleY = H * 0.36;
  const subtitle = narrow
    ? "SAME DEAL · RACE THE BOT"
    : "SAME DEAL. RACE THE BOT. FIRST TO CLEAR WINS.";
  const subtitleSize = H * (narrow ? 0.03 : 0.021);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${defs()}
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <ellipse cx="${cx}" cy="${H * 0.44}" rx="${W * 0.34}" ry="${H * 0.52}" fill="url(#halo)"/>
    <ellipse cx="${W * 0.82}" cy="${H * 0.92}" rx="${W * 0.3}" ry="${H * 0.4}" fill="url(#warm)"/>

    <!-- The race: the same deal, two boards. -->
    ${cardBack({ x: cx - cardW * 1.42, y: cardY + H * 0.03, w: cardW, h: cardH, rot: -16 })}
    ${cardFace({ x: cx - cardW * 0.62, y: cardY, w: cardW, h: cardH, rot: -5, rank: "A", mark: "spade", color: CARD_INK })}
    ${cardFace({ x: cx + cardW * 0.2, y: cardY + H * 0.015, w: cardW, h: cardH, rot: 8, rank: "K", mark: "heart", color: CARD_RED })}

    <text x="${textX}" y="${titleY}" font-family="${FONT}" font-size="${titleSize}" font-weight="900" fill="${WHITE}" letter-spacing="${titleSize * 0.02}">SOLITAIRE</text>
    <text x="${textX}" y="${titleY + titleSize * 0.94}" font-family="${FONT}" font-size="${titleSize}" font-weight="900" fill="${CYAN}" letter-spacing="${titleSize * 0.02}">DUEL</text>
    <rect x="${textX + titleSize * 0.03}" y="${titleY + titleSize * 1.22}" width="${W * 0.09}" height="${H * 0.007}" rx="${H * 0.0035}" fill="${CYAN}"/>
    <text x="${textX}" y="${titleY + titleSize * 1.62}" font-family="${FONT}" font-size="${subtitleSize}" font-weight="700" fill="${WHITE}" fill-opacity="0.62" letter-spacing="${subtitleSize * 0.13}">${subtitle}</text>

    ${progressBars({
      x: textX,
      y: H * 0.74,
      w: W * 0.4,
      h: H * 0.011,
      rows: [
        { label: "YOU", pct: 0.72, fill: "amberBar" },
        { label: "BOT", pct: 0.48, fill: "cyanBar" },
      ],
    })}

    ${wordmark({ x: textX, y: H * 0.95, size: H * 0.022, anchor: "start", opacity: 0.35 })}
  </svg>`;
}

/** Portrait / square cover: stacked title over a two-card fan. */
function verticalCover(W, H) {
  const compact = H / W < 1.35;
  const titleSize = H * (compact ? 0.072 : 0.062);
  const cardW = W * (compact ? 0.27 : 0.34);
  const cardH = cardW * 1.4;
  const fanY = H * (compact ? 0.56 : 0.6) - cardH / 2;
  const titleY = H * (compact ? 0.2 : 0.24);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${defs()}
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <ellipse cx="${W * 0.5}" cy="${H * 0.52}" rx="${W * 0.62}" ry="${H * 0.42}" fill="url(#halo)"/>
    <ellipse cx="${W * 0.5}" cy="${H * 1.02}" rx="${W * 0.7}" ry="${H * 0.22}" fill="url(#warm)"/>

    <text x="${W * 0.5}" y="${titleY}" text-anchor="middle" font-family="${FONT}" font-size="${titleSize}" font-weight="900" fill="${WHITE}" letter-spacing="${titleSize * 0.02}">SOLITAIRE</text>
    <text x="${W * 0.5}" y="${titleY + titleSize * 0.98}" text-anchor="middle" font-family="${FONT}" font-size="${titleSize}" font-weight="900" fill="${CYAN}" letter-spacing="${titleSize * 0.02}">DUEL</text>
    <text x="${W * 0.5}" y="${titleY + titleSize * 1.72}" text-anchor="middle" font-family="${FONT}" font-size="${titleSize * 0.35}" font-weight="700" fill="${WHITE}" fill-opacity="0.6" letter-spacing="${titleSize * 0.07}">SAME DEAL · RACE THE BOT</text>

    ${cardBack({ x: W * 0.5 - cardW * 0.86, y: fanY + H * 0.012, w: cardW, h: cardH, rot: -11 })}
    ${cardFace({ x: W * 0.5 - cardW * 0.34, y: fanY, w: cardW, h: cardH, rot: 7, rank: "A", mark: "spade", color: CARD_INK })}

    ${progressBars({
      x: W * 0.1,
      y: H * 0.845,
      w: W * 0.8,
      h: H * 0.008,
      rows: [
        { label: "YOU", pct: 0.72, fill: "amberBar" },
        { label: "BOT", pct: 0.48, fill: "cyanBar" },
      ],
    })}

    ${wordmark({ x: W * 0.5, y: H * 0.965, size: H * 0.018, anchor: "middle", opacity: 0.38 })}
  </svg>`;
}

/** The application icon: legible from 512 px down to 32 px. */
function iconSvg() {
  const S = 512;
  const cardW = 196;
  const cardH = 268;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
    ${defs()}
    <rect width="${S}" height="${S}" rx="112" fill="url(#bg)"/>
    <ellipse cx="256" cy="210" rx="250" ry="210" fill="url(#halo)"/>
    <g transform="translate(0 -6) rotate(-13 256 256)">
      <rect x="176" y="112" width="${cardW}" height="${cardH}" rx="22" fill="url(#back)" stroke="#1f3a5f" stroke-width="4"/>
      <rect x="192" y="128" width="${cardW - 32}" height="${cardH - 32}" rx="14" fill="none" stroke="${CYAN}" stroke-opacity="0.34" stroke-width="4"/>
    </g>
    <g transform="translate(0 4) rotate(9 256 256)">
      <rect x="168" y="118" width="${cardW}" height="${cardH}" rx="22" fill="url(#face)"/>
      <rect x="168" y="118" width="${cardW}" height="${cardH}" rx="22" fill="none" stroke="#04070f" stroke-opacity="0.3" stroke-width="3"/>
      ${suit("spade", { x: 256 - 58, y: 246 - 58, size: 116, color: "#0c1420" })}
    </g>
  </svg>`;
}

// A tiny, hand-minified copy of the icon for the SVG favicon. Browsers scale it
// to 16 px, where the card + spade is all that survives.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f1936"/><stop offset="1" stop-color="#04070f"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/><g transform="rotate(-13 256 256)"><rect x="176" y="112" width="196" height="268" rx="22" fill="#1d3a60"/></g><g transform="rotate(9 256 256)"><rect x="168" y="118" width="196" height="268" rx="22" fill="#f3f7fd"/><path d="${SUITS.spade}" transform="translate(198 188) scale(4.83)" fill="#0c1420"/></g></svg>
`;

/** Wrap PNG bytes in the ICO container. Browsers accept a PNG payload in an ICO. */
function icoFromPng(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, png]);
}

async function render(svg, width, height) {
  return sharp(Buffer.from(svg), { density: 144 })
    .resize(width, height, { fit: "fill" })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

await mkdir(ICON_DIR, { recursive: true });
await mkdir(COVER_DIR, { recursive: true });

const written = [];

async function save(path, data) {
  await writeFile(path, data);
  written.push({ path, bytes: statSync(path).size });
}

// ── Package icons (shipped inside the build) ─────────────────────────────
const icon = iconSvg();
await save(join(ICON_DIR, "favicon.svg"), Buffer.from(FAVICON_SVG, "utf8"));
for (const [name, size] of [
  ["favicon-32.png", 32],
  ["apple-touch-icon.png", 180],
  ["icon-512.png", 512],
]) {
  await save(join(ICON_DIR, name), await render(icon, size, size));
}
const png32 = await render(icon, 32, 32);
await save(join(ICON_DIR, "favicon.ico"), icoFromPng(png32, 32));

// ── Submission covers (uploaded to the portal form, not the game ZIP) ────
for (const [name, w, h, svg] of [
  ["cover-landscape-1920x1080.png", 1920, 1080, horizontalCover(1920, 1080)],
  ["cover-portrait-800x1200.png", 800, 1200, verticalCover(800, 1200)],
  ["cover-square-800x800.png", 800, 800, verticalCover(800, 800)],
  ["cover-itch-630x500.png", 630, 500, horizontalCover(630, 500)],
  ["social-1200x630.png", 1200, 630, horizontalCover(1200, 630)],
]) {
  await save(join(COVER_DIR, name), await render(svg, w, h));
}

for (const { path, bytes } of written) {
  console.log(`${path.replace(REPO, ".").replace(/\\/g, "/")}  ${kb(bytes)}`);
}
console.log(`\n${written.length} images written.`);
