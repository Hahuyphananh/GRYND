// scripts/render-four-in-a-row-svg.js
//
// Regenerates src/images/four-in-a-row.svg as a 16:9 casino game-card image
// (1536x864, same frame as the other "-div" card images):
//   - The plain navy backdrop is replaced by grynd-master-bg.jpg, embedded
//     as a base64 JPEG so the SVG stays self-contained.
//   - The board scene is scaled (1.4x) and centered so the ENTIRE board
//     (including the drop indicator above it) is visible inside the frame
//     when the card renders it with object-cover.
//   - A soft vignette darkens the frame edges to focus the neon board.
//
// Run: node scripts/render-four-in-a-row-svg.js

const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src", "images");

const W = 1536;
const H = 864; // 16:9 — same aspect as grynd-master-bg.jpg (1376x768)

// Board scene geometry (from the original 480x480 canvas):
//   - board frame spans x 90..390, y 80..380 (center 240, 230)
//   - content extends up to the drop indicator glow (~y 74)
//   - content center used for the scale+translate wrap: (240, 233.5)
const SCALE = 1.5;

(async () => {
  // 1. Compressed grynd-master backdrop as a base64 JPEG.
  const bg = await sharp(path.join(SRC, "grynd-master-bg.jpg"))
    .resize(W, H, { fit: "fill" })
    .jpeg({ quality: 80 })
    .toBuffer();
  const bgB64 = bg.toString("base64");

  // 2. Read the existing four-in-a-row.svg and reuse its defs + scene.
  const srcSvg = fs.readFileSync(path.join(SRC, "four-in-a-row.svg"), "utf8");
  const defsStart = srcSvg.indexOf("<defs>");
  const defsEnd = srcSvg.indexOf("</defs>");
  if (defsStart < 0 || defsEnd < 0) throw new Error("defs block not found in four-in-a-row.svg");
  const defsBlock = srcSvg.slice(defsStart, defsEnd + "</defs>".length);

  // 3. Body = everything after </defs>, minus the plain navy backdrop rect
  //    (replaced by the grynd-master image) and the trailing </svg>.
  let body = srcSvg.slice(defsEnd + "</defs>".length);
  body = body.replace(/<rect width="480" height="480" fill="#0b1f3f"\/>/, "");
  body = body.replace(/<\/svg>\s*$/, "").trim();

  // 4. Soft vignette to focus the board.
  const vignette = `
    <radialGradient id="vignette" cx="50%" cy="50%" r="75%">
      <stop offset="0%" stop-color="#020617" stop-opacity="0"/>
      <stop offset="55%" stop-color="#020617" stop-opacity="0"/>
      <stop offset="100%" stop-color="#020617" stop-opacity="0.5"/>
    </radialGradient>`;

  const newSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Four-In-A-Row. Neon 7×6 board with purple and blue discs">
  <title>Four-In-A-Row</title>
  ${defsBlock.replace("</defs>", `${vignette}\n  </defs>`)}
  <!-- grynd-master casino backdrop (embedded). -->
  <image href="data:image/jpeg;base64,${bgB64}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>
  <!-- Vignette over the backdrop, edges only. -->
  <rect width="${W}" height="${H}" fill="url(#vignette)"/>
  <!-- Board scene: scaled 1.4x and centered so the whole board is visible. -->
  <g transform="translate(${W / 2} ${H / 2}) scale(${SCALE}) translate(-240 -233.5)">
${body}
  </g>
</svg>
`;

  fs.writeFileSync(path.join(SRC, "four-in-a-row.svg"), newSvg);
  console.log(
    `wrote src/images/four-in-a-row.svg (${(Buffer.byteLength(newSvg) / 1024).toFixed(0)} KB, ` +
      `embedded bg ${(bgB64.length / 1024).toFixed(0)} KB)`
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
