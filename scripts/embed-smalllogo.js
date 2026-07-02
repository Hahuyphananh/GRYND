// Embeds the actual src/images/smalllogo.png as a base64 data URI inside
// src/images/coin-flip.svg, replacing the prior mascot-disc + GOONBET
// subtitle approximation.
const fs = require('fs');
const path = require('path');

const pngPath = path.resolve(__dirname, '..', 'src', 'images', 'smalllogo.png');
const svgPath = path.resolve(__dirname, '..', 'src', 'images', 'coin-flip.svg');

const png = fs.readFileSync(pngPath);
const b64 = png.toString('base64');
const originalSvg = fs.readFileSync(svgPath, 'utf8');

// Anchor 1: the comment that opens the prior GOONBET LOGO block.
const startMarker = '<!-- GOONBET LOGO';
const startIdx = originalSvg.indexOf(startMarker);
if (startIdx < 0) {
  console.error('START_MARKER_NOT_FOUND');
  process.exit(1);
}

// Anchor 2: the GOON subtitle `<text>` element we want to fully replace through.
const textPattern = '<text x="0" y="65"';
const textIdx = originalSvg.indexOf(textPattern, startIdx);
if (textIdx < 0) {
  console.error('TEXT_MARKER_NOT_FOUND');
  process.exit(1);
}

const closeTextIdx = originalSvg.indexOf('</text>', textIdx);
if (closeTextIdx < 0) {
  console.error('CLOSE_TEXT_NOT_FOUND');
  process.exit(1);
}

let afterIdx = closeTextIdx + '</text>'.length;
// Skip to (and past) the trailing newline of that line so the next line stays intact.
while (afterIdx < originalSvg.length && originalSvg[afterIdx] !== '\n') afterIdx++;
if (afterIdx < originalSvg.length) afterIdx++;

const replacement = [
  '<!-- GoonBet brand mark from src/images/smalllogo.png, inlined as a base64',
  '         data URI so it renders inside the coin without external lookup.',
  '         The PNG\'s intrinsic aspect ratio is preserved. -->',
  '    <image href="data:image/png;base64,' + b64 + '"',
  '           xlink:href="data:image/png;base64,' + b64 + '"',
  '           x="-60" y="-60" width="120" height="120"',
  '           preserveAspectRatio="xMidYMid meet"/>',
].join('\n');

const nextSvg =
  originalSvg.slice(0, startIdx) +
  replacement +
  '\n' +
  originalSvg.slice(afterIdx);

fs.writeFileSync(svgPath, nextSvg, 'utf8');

console.log(JSON.stringify({
  pngBytes: png.length,
  base64Len: b64.length,
  beforeLen: originalSvg.length,
  afterLen: nextSvg.length,
  removedBytes: (originalSvg.length - nextSvg.length),
  startMarkerFound: true,
  textMarkerFound: true,
  closeTextFound: true,
}));
