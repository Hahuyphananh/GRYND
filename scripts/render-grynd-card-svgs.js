// scripts/render-grynd-card-svgs.js
//
// Regenerates the SVG casino game-card images (pool, hex-duel, dice-flush,
// dots-and-boxes, precision) with grynd-master-bg.jpg replacing the plain
// navy backdrop:
//   - Default mode renders each card at 16:9 (1536x864, same frame as the
//     "-div" card images) and wraps the scene in a scale+translate group so
//     the whole subject fits comfortably inside the frame's visible crop
//     band (even under the card's hover zoom / tightest 3-column layout).
//   - `restoreOriginalSize: true` keeps the SVG at its original canvas size
//     (its viewBox) with the master background embedded and the scene at
//     its original coordinates — only the backdrop is swapped.
//   - The background is embedded as a base64 JPEG so each SVG stays
//     self-contained, and a soft vignette darkens the edges.
//
// The script is idempotent: re-running it on an already-generated file
// unwraps the previous injection first.
//
// Run: node scripts/render-grynd-card-svgs.js

const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src", "images");

const W = 1536;
const H = 864; // 16:9 — same aspect as grynd-master-bg.jpg (1376x768)

// Per-card scene geometry: the content center (CX, CY) in the original
// canvas and the uniform scale so the subject height lands at ~400px in
// the 864px frame (well inside the visible band for every layout).
// Cards with `restoreOriginalSize: true` keep their original canvas size.
const CARDS = [
  // pool: table spans x 80..400, y 120..360 → center (240, 240), 320x240
  { file: "pool.svg", center: [240, 240], scale: 1.95 },
  // hex-duel: cluster translate(200 102), hexes span x ±76, y 22..182
  { file: "hex-duel.svg", center: [200, 102], scale: 3.2 },
  // lane-rush: twin towers span x 16..464, y 12..360 → center (240, 186)
  { file: "lane-rush.svg", center: [240, 186], scale: 1.65 },
  // odds: live-round duel spans x 14..386, y 8..210 → center (200, 112)
  { file: "odds.svg", center: [200, 112], scale: 2.75 },
  // dice-flush: keep the original 400x300 canvas, only swap the backdrop
  { file: "dice-flush.svg", restoreOriginalSize: true, size: [400, 300] },
  // dots-and-boxes: keep the original 600x400 canvas, only swap the backdrop
  { file: "dots-and-boxes.svg", restoreOriginalSize: true, size: [600, 400] },
  // precision: keep the original 400x300 canvas, only swap the backdrop
  { file: "precision.svg", restoreOriginalSize: true, size: [400, 300] },
];

const VIGNETTE = `
    <radialGradient id="vignette" cx="50%" cy="50%" r="75%">
      <stop offset="0%" stop-color="#020617" stop-opacity="0"/>
      <stop offset="55%" stop-color="#020617" stop-opacity="0"/>
      <stop offset="100%" stop-color="#020617" stop-opacity="0.5"/>
    </radialGradient>`;

// Undo a previous injection so re-running is safe: strips the embedded
// backdrop image, the vignette rect, the scene wrapper group (and its
// matching close), and any vignette gradient already in <defs>.
function unwrapInjected(s, file) {
  const startMarker = "<!-- grynd-master casino backdrop (embedded). -->";
  const start = s.indexOf(startMarker);
  if (start < 0) return s; // pristine original — nothing to unwrap

  const vignetteMarker = "<!-- Vignette over the backdrop, edges only. -->";
  const vignetteOpen = s.indexOf(vignetteMarker, start);
  const vignetteEnd = s.indexOf("/>", vignetteOpen) + 2; // end of the vignette rect
  const svgCloseIdx = s.lastIndexOf("</svg>");
  if (vignetteOpen < 0 || svgCloseIdx < 0) throw new Error("unexpected injected layout in " + file);

  // 16:9 mode also wraps the scene in a transform group — strip it too.
  const sceneMarker = "<!-- Scene: scaled and centered so the whole subject is visible. -->";
  const sceneOpen = s.indexOf(sceneMarker, start);
  let out;
  if (sceneOpen >= 0) {
    const wrapperOpen = s.indexOf("<g", sceneOpen);
    const openEnd = s.indexOf(">", wrapperOpen) + 1; // end of the wrapper <g ...>
    const closeIdx = s.lastIndexOf("</g>"); // wrapper's matching close
    if (closeIdx < 0) throw new Error("unexpected injected layout in " + file);
    out = s.slice(0, start) + s.slice(openEnd, closeIdx) + s.slice(svgCloseIdx);
  } else {
    // restore-size mode: only the image + vignette rect were added.
    out = s.slice(0, start) + s.slice(vignetteEnd, svgCloseIdx) + s.slice(svgCloseIdx);
  }
  // Drop a vignette gradient that a previous run added to <defs>.
  out = out.replace(/[ \t]*<radialGradient id="vignette"[\s\S]*?<\/radialGradient>\n/, "");
  return out;
}

(async () => {
  for (const card of CARDS) {
    let srcSvg = fs.readFileSync(path.join(SRC, card.file), "utf8");
    srcSvg = unwrapInjected(srcSvg, card.file);

    const restoreSize = !!card.restoreOriginalSize;
    const cw = restoreSize ? (card.size ? card.size[0] : W) : W;
    const ch = restoreSize ? (card.size ? card.size[1] : H) : H;

    // Compressed grynd-master backdrop, sized to this card's canvas.
    const bg = await sharp(path.join(SRC, "grynd-master-bg.jpg"))
      .resize(cw, ch, { fit: "fill" })
      .jpeg({ quality: 80 })
      .toBuffer();
    const bgB64 = bg.toString("base64");

    // Root <svg ...> open tag (up to its first ">"). Skip past the
    // optional <?xml ...?> declaration so we find the svg tag itself.
    const svgTagStart = srcSvg.indexOf("<svg");
    const rootEnd = srcSvg.indexOf(">", svgTagStart);
    let rootTag = srcSvg.slice(svgTagStart, rootEnd + 1);
    rootTag = rootTag.replace(/viewBox="[^"]*"/, `viewBox="0 0 ${cw} ${ch}"`);
    rootTag = rootTag.replace(/\s+preserveAspectRatio="[^"]*"/, "");

    const defsStart = srcSvg.indexOf("<defs>");
    const defsEnd = srcSvg.indexOf("</defs>");
    if (defsStart < 0 || defsEnd < 0) throw new Error(`defs block not found in ${card.file}`);
    const between = srcSvg.slice(rootEnd + 1, defsStart); // titles/comments
    const defsBlock = srcSvg.slice(defsStart, defsEnd + "</defs>".length);

    // Body = everything after </defs>, minus the old backdrop rect and </svg>.
    let body = srcSvg.slice(defsEnd + "</defs>".length);
    body = body.replace(/<rect\b[^>]*fill="#0b1f3f"[^>]*\/>/, ""); // plain navy rects
    body = body.replace(/<rect\b[^>]*fill="url\(#bg\)"[^>]*\/>/, ""); // hex-duel gradient
    body = body.replace(/<\/svg>\s*$/, "").trim();

    const sceneWrap =
      restoreSize
        ? ""
        : `  <!-- Scene: scaled and centered so the whole subject is visible. -->\n` +
          `  <g transform="translate(${W / 2} ${H / 2}) scale(${card.scale}) translate(-${card.center[0]} -${card.center[1]})">\n`;
    const sceneClose = restoreSize ? "" : `\n  </g>`;

    const newSvg = `${rootTag}\n${between}  ${defsBlock.replace("</defs>", `${VIGNETTE}\n  </defs>`)}\n  <!-- grynd-master casino backdrop (embedded). -->\n  <image href="data:image/jpeg;base64,${bgB64}" x="0" y="0" width="${cw}" height="${ch}" preserveAspectRatio="none"/>\n  <!-- Vignette over the backdrop, edges only. -->\n  <rect width="${cw}" height="${ch}" fill="url(#vignette)"/>\n${sceneWrap}${body}${sceneClose}\n</svg>\n`;

    fs.writeFileSync(path.join(SRC, card.file), newSvg);
    console.log(
      `wrote ${card.file} (${(Buffer.byteLength(newSvg) / 1024).toFixed(0)} KB, ${cw}x${ch})`
    );
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
