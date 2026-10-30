/**
 * Phase 7 — GRYND launcher icon + splash branding.
 *
 * These tests check the Android resources that actually ship in the APK:
 * the adaptive icon layers, the legacy mipmaps, the launch drawables for every
 * density/orientation, and that no stock Capacitor / Android Studio art is left
 * active. They cannot prove the icon looks right on real hardware — that still
 * needs a device or emulator.
 *
 *   npm run test:android-branding
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RES = path.join(ROOT, "android/app/src/main/res");

const rel = (p) => path.join(RES, p);
const read = (p) => readFileSync(rel(p), "utf8");

// GRYND dark-theme base — the icon background and every launch frame.
const NAVY = { r: 0x03, g: 0x08, b: 0x17 };

const DENSITIES = [
  { dir: "mdpi", scale: 1 },
  { dir: "hdpi", scale: 1.5 },
  { dir: "xhdpi", scale: 2 },
  { dir: "xxhdpi", scale: 3 },
  { dir: "xxxhdpi", scale: 4 },
];

const SPLASH = [
  { dir: "drawable", width: 480, height: 320 },
  { dir: "drawable-port-mdpi", width: 320, height: 480 },
  { dir: "drawable-port-hdpi", width: 480, height: 800 },
  { dir: "drawable-port-xhdpi", width: 720, height: 1280 },
  { dir: "drawable-port-xxhdpi", width: 960, height: 1600 },
  { dir: "drawable-port-xxxhdpi", width: 1280, height: 1920 },
  { dir: "drawable-land-mdpi", width: 480, height: 320 },
  { dir: "drawable-land-hdpi", width: 800, height: 480 },
  { dir: "drawable-land-xhdpi", width: 1280, height: 720 },
  { dir: "drawable-land-xxhdpi", width: 1600, height: 960 },
  { dir: "drawable-land-xxxhdpi", width: 1920, height: 1280 },
];

function pngHeader(file) {
  const buf = readFileSync(file);
  assert.equal(
    buf.subarray(1, 4).toString("ascii"),
    "PNG",
    `${file} is not a PNG`,
  );
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25], // 6 = truecolour with alpha
  };
}

async function raw(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, info };
}

function pixel({ data, info }, x, y) {
  const i = (y * info.width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

// The GRYND mark is a saturated yellow; the surfaces behind it are navy.
function isMark(p) {
  return p.a > 200 && p.r > 120 && p.g > 100 && p.r - p.b > 60;
}

test("the adaptive icon layers point at GRYND resources", () => {
  for (const file of [
    "mipmap-anydpi-v26/ic_launcher.xml",
    "mipmap-anydpi-v26/ic_launcher_round.xml",
  ]) {
    const xml = read(file);
    assert.match(
      xml,
      /<background android:drawable="@color\/ic_launcher_background"/,
      `${file} must use the brand background colour`,
    );
    assert.match(
      xml,
      /<foreground android:drawable="@mipmap\/ic_launcher_foreground"/,
      `${file} must use the GRYND foreground layer`,
    );
  }
});

test("the adaptive background is GRYND navy, not template black or teal", () => {
  assert.match(
    read("values/ic_launcher_background.xml"),
    /<color name="ic_launcher_background">#030817<\/color>/,
  );

  const vector = read("drawable/ic_launcher_background.xml");
  assert.match(vector, /android:fillColor="#030817"/);
  assert.ok(
    !/#26A69A/i.test(vector),
    "the stock teal template grid must be gone from the background drawable",
  );
});

test("every density ships a foreground, square and round launcher icon", () => {
  for (const { dir, scale } of DENSITIES) {
    const foreground = pngHeader(rel(`mipmap-${dir}/ic_launcher_foreground.png`));
    const legacy = pngHeader(rel(`mipmap-${dir}/ic_launcher.png`));
    const round = pngHeader(rel(`mipmap-${dir}/ic_launcher_round.png`));

    assert.deepEqual(
      { w: foreground.width, h: foreground.height },
      { w: Math.round(108 * scale), h: Math.round(108 * scale) },
      `mipmap-${dir} foreground must be the 108dp adaptive canvas`,
    );
    assert.equal(
      foreground.colorType,
      6,
      `mipmap-${dir} foreground must keep an alpha channel (background is a separate layer)`,
    );

    const legacySize = Math.round(48 * scale);
    assert.deepEqual(
      { w: legacy.width, h: legacy.height },
      { w: legacySize, h: legacySize },
      `mipmap-${dir} legacy icon must be 48dp`,
    );
    assert.deepEqual(
      { w: round.width, h: round.height },
      { w: legacySize, h: legacySize },
      `mipmap-${dir} round icon must be 48dp`,
    );
  }
});

test("the adaptive foreground is a transparent, correctly scaled GRYND mark", async () => {
  for (const { dir, scale } of DENSITIES) {
    const file = rel(`mipmap-${dir}/ic_launcher_foreground.png`);
    const image = await raw(file);
    const size = Math.round(108 * scale);

    // Corners are outside the launcher safe zone: they must be empty so the
    // navy background layer shows through instead of a pasted square.
    for (const [x, y] of [
      [0, 0],
      [size - 1, 0],
      [0, size - 1],
      [size - 1, size - 1],
    ]) {
      assert.equal(
        pixel(image, x, y).a,
        0,
        `mipmap-${dir} foreground corner (${x},${y}) must be transparent`,
      );
    }

    // The mark must fill ~60% of the canvas and be centred: big enough to read
    // at launcher size, small enough to stay inside the 66/108dp safe zone.
    let marked = 0;
    let minX = size;
    let minY = size;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (pixel(image, x, y).a > 200) {
          marked += 1;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    assert.ok(marked > 0, `mipmap-${dir} foreground must contain the GRYND mark`);

    const markW = maxX - minX + 1;
    const markH = maxY - minY + 1;
    const extent = Math.max(markW, markH) / size;
    assert.ok(
      extent > 0.5 && extent < 0.7,
      `mipmap-${dir} mark spans ${(extent * 100).toFixed(1)}% of the canvas — expected 50-70%`,
    );

    const centreX = (minX + maxX + 1) / 2;
    const centreY = (minY + maxY + 1) / 2;
    assert.ok(
      Math.abs(centreX - size / 2) <= 2 && Math.abs(centreY - size / 2) <= 2,
      `mipmap-${dir} mark must be centred (got ${centreX},${centreY} of ${size})`,
    );
  }
});

test("legacy icons sit the mark on the navy brand surface", async () => {
  for (const { dir, scale } of DENSITIES) {
    const legacy = await raw(rel(`mipmap-${dir}/ic_launcher.png`));
    const size = Math.round(48 * scale);
    const corner = pixel(legacy, 0, 0);

    assert.equal(corner.a, 255, `mipmap-${dir} legacy icon must be opaque`);
    assert.ok(
      Math.abs(corner.r - NAVY.r) <= 6 &&
        Math.abs(corner.g - NAVY.g) <= 6 &&
        Math.abs(corner.b - NAVY.b) <= 6,
      `mipmap-${dir} legacy icon background must be GRYND navy`,
    );

    const centre = pixel(legacy, Math.floor(size / 2), Math.floor(size / 2));
    assert.ok(
      centre.a === 255,
      `mipmap-${dir} legacy icon must paint the full square`,
    );

    // The mark must appear somewhere in the icon body.
    let marked = 0;
    for (let i = 0; i < legacy.data.length; i += 4) {
      if (
        isMark({
          r: legacy.data[i],
          g: legacy.data[i + 1],
          b: legacy.data[i + 2],
          a: legacy.data[i + 3],
        })
      ) {
        marked += 1;
      }
    }
    assert.ok(marked > 0, `mipmap-${dir} legacy icon must contain the GRYND mark`);
  }
});

test("the round icon is a circle, not a square badge", async () => {
  for (const { dir, scale } of DENSITIES) {
    const file = rel(`mipmap-${dir}/ic_launcher_round.png`);
    const image = await raw(file);
    const size = Math.round(48 * scale);

    assert.equal(
      pixel(image, 0, 0).a,
      0,
      `mipmap-${dir} round icon corners must be transparent outside the circle`,
    );
    assert.equal(
      pixel(image, Math.floor(size / 2), Math.floor(size / 2)).a,
      255,
      `mipmap-${dir} round icon must be opaque in the middle`,
    );
  }
});

test("every splash drawable is branded, dark and correctly sized", async () => {
  for (const { dir, width, height } of SPLASH) {
    const file = rel(`${dir}/splash.png`);
    assert.ok(existsSync(file), `${dir}/splash.png is missing`);

    const header = pngHeader(file);
    assert.deepEqual(
      { w: header.width, h: header.height },
      { w: width, h: height },
      `${dir}/splash.png keeps the template's ${width}x${height} size`,
    );

    const image = await raw(file);

    // Corners: the old stock drawable was white. Must now be the dark gradient.
    for (const [x, y] of [
      [0, 0],
      [width - 1, height - 1],
    ]) {
      const p = pixel(image, x, y);
      assert.ok(
        p.r + p.g + p.b < 120,
        `${dir}/splash.png corner (${x},${y}) must be dark navy, got rgb(${p.r},${p.g},${p.b})`,
      );
    }

    // The mark must be visible in the middle third of the frame.
    let marked = 0;
    const x0 = Math.floor(width / 3);
    const x1 = Math.ceil((width * 2) / 3);
    const y0 = Math.floor(height / 3);
    const y1 = Math.ceil((height * 2) / 3);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (isMark(pixel(image, x, y))) marked += 1;
      }
    }
    assert.ok(
      marked > 0,
      `${dir}/splash.png must show the GRYND mark in the centre of the frame`,
    );
  }
});

test("the launch themes stay dark on every Android version", () => {
  const base = read("values/styles.xml");
  assert.match(base, /name="AppTheme\.NoActionBarLaunch" parent="Theme\.SplashScreen"/);
  assert.match(base, /android:background">@drawable\/splash/);
  assert.match(base, /android:statusBarColor">#030817/);

  // API 31+ draws its own splash; it must not fall back to platform defaults.
  const v31 = read("values-v31/styles.xml");
  assert.match(v31, /name="AppTheme\.NoActionBarLaunch" parent="Theme\.SplashScreen"/);
  assert.match(v31, /android:windowSplashScreenBackground">#030817/);
  assert.match(
    v31,
    /android:windowSplashScreenAnimatedIcon">@mipmap\/ic_launcher</,
  );
});

test("no stock Capacitor / template icon art remains active", () => {
  // The template's white robot vector is deleted outright; nothing references it.
  assert.ok(
    !existsSync(rel("drawable-v24/ic_launcher_foreground.xml")),
    "the stock Android robot foreground vector must not be shipped",
  );

  // The stock splash's flat-white field is gone from every density.
  assert.ok(
    !read("values/styles.xml").includes("#26A69A"),
    "no template teal in the theme",
  );
});

test("identity is unchanged: GRYND, com.grynd.app, adaptive icon wired up", () => {
  const strings = read("values/strings.xml");
  assert.match(strings, /<string name="app_name">GRYND<\/string>/);
  assert.match(strings, /<string name="package_name">com\.grynd\.app<\/string>/);

  const manifest = readFileSync(
    path.join(ROOT, "android/app/src/main/AndroidManifest.xml"),
    "utf8",
  );
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
  assert.match(manifest, /android:label="@string\/app_name"/);
});
