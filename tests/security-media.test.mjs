/**
 * Security — profile-picture / upload validation.
 *
 * Pure-function tests for `src/lib/security/media.js`, the shared
 * write-time (server) + display-time (client) gate for user-uploaded
 * images. The contract under test:
 *   * only base64 `data:` URLs of REAL raster images (png / jpeg /
 *     webp / gif / avif) whose magic bytes match the declared MIME;
 *   * or https:// URLs;
 *   * everything else — SVG (script-capable), HTML, PHP/JSP payloads,
 *     javascript:/file:/vbscript: URLs, unknown data MIMEs — rejected.
 *
 * Run: node --test tests/security-media.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  isSafeProfilePicture,
  isSafeProfilePictureUrl,
  sanitizeProfilePicture,
  sniffImageType,
} from "../src/lib/security/media.js";

/** Build a `data:image/<mime>;base64,` URL from a byte array. */
function dataUrl(mime, bytes) {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Minimal-but-sniffable raster headers (padded past the 12-byte floor). */
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3];
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3];
const GIF_BYTES = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0, 1, 2, 3];
const WEBP_BYTES = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3];
const AVIF_BYTES = [0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 1, 2, 3];

// ═══════════════════════════════════════════════════════════════════
// sniffImageType
// ═══════════════════════════════════════════════════════════════════

test("sniffImageType recognises every allow-listed raster format", () => {
  assert.equal(sniffImageType(new Uint8Array(PNG_BYTES)), "image/png");
  assert.equal(sniffImageType(new Uint8Array(JPEG_BYTES)), "image/jpeg");
  assert.equal(sniffImageType(new Uint8Array(GIF_BYTES)), "image/gif");
  assert.equal(sniffImageType(new Uint8Array(WEBP_BYTES)), "image/webp");
  assert.equal(sniffImageType(new Uint8Array(AVIF_BYTES)), "image/avif");
});

test("sniffImageType rejects executable / malformed content", () => {
  // Raw PHP: `<?php ...` — not a raster image.
  const php = new Uint8Array([0x3c, 0x3f, 0x70, 0x68, 0x70, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffImageType(php), null);
  // Raw JSP: `<% ...` — not a raster image.
  const jsp = new Uint8Array([0x3c, 0x25, 0x40, 0x70, 0x61, 0x67, 0x65, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffImageType(jsp), null);
  // HTML document.
  const html = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffImageType(html), null);
  // Too short to be anything.
  assert.equal(sniffImageType(new Uint8Array([1, 2, 3])), null);
  assert.equal(sniffImageType(null), null);
});

// ═══════════════════════════════════════════════════════════════════
// isSafeProfilePicture — accepted values
// ═══════════════════════════════════════════════════════════════════

test("accepts base64 data URLs of real raster images", () => {
  const cases = [
    ["image/png", PNG_BYTES],
    ["image/jpeg", JPEG_BYTES],
    ["image/gif", GIF_BYTES],
    ["image/webp", WEBP_BYTES],
    ["image/avif", AVIF_BYTES],
  ];
  for (const [mime, bytes] of cases) {
    const url = dataUrl(mime, bytes);
    const result = isSafeProfilePicture(url);
    assert.equal(result.ok, true, `${mime} should be accepted`);
    assert.equal(result.sanitized, url);
  }
});

test("accepts https:// URLs (e.g. Clerk-hosted avatars)", () => {
  const result = isSafeProfilePicture("https://img.clerk.com/preview/abc123.png");
  assert.equal(result.ok, true);
  assert.equal(result.sanitized, "https://img.clerk.com/preview/abc123.png");
});

test("null / empty string mean 'cleared' and are accepted", () => {
  assert.deepEqual(isSafeProfilePicture(null), { ok: true, sanitized: null });
  assert.deepEqual(isSafeProfilePicture(undefined), { ok: true, sanitized: null });
  assert.deepEqual(isSafeProfilePicture(""), { ok: true, sanitized: null });
  assert.deepEqual(isSafeProfilePicture("   "), { ok: true, sanitized: null });
});

// ═══════════════════════════════════════════════════════════════════
// isSafeProfilePicture — rejected values
// ═══════════════════════════════════════════════════════════════════

test("rejects SVG data URLs (script-capable)", () => {
  const svg = dataUrl("image/svg+xml", Buffer.from("<svg onload=alert(1)>"));
  const result = isSafeProfilePicture(svg);
  assert.equal(result.ok, false);
  assert.match(result.error, /Unsupported image type/);
  // Non-base64 SVG data URL is also rejected.
  assert.equal(isSafeProfilePicture("data:image/svg+xml,%3Csvg%3E").ok, false);
});

test("rejects javascript:, file: and vbscript: URLs", () => {
  for (const bad of [
    "javascript:alert(document.cookie)",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
  ]) {
    const result = isSafeProfilePicture(bad);
    assert.equal(result.ok, false, `${bad} must be rejected`);
  }
});

test("rejects data:text/html and other non-image data URLs", () => {
  const html = dataUrl("text/html", Buffer.from("<script>alert(1)</script>"));
  assert.equal(isSafeProfilePicture(html).ok, false);
  const pdf = dataUrl("application/pdf", [0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(isSafeProfilePicture(pdf).ok, false);
});

test("rejects MIME-mismatched polyglots (declared type != real bytes)", () => {
  // Declared PNG, actual JPEG bytes — must be rejected.
  const url = dataUrl("image/png", JPEG_BYTES);
  const result = isSafeProfilePicture(url);
  assert.equal(result.ok, false);
  assert.match(result.error, /does not match/);
});

test("rejects raw PHP/JSP payloads disguised as images", () => {
  // A .php file's actual bytes (<?php ...) as a data URL — rejected.
  const php = dataUrl("image/png", [0x3c, 0x3f, 0x70, 0x68, 0x70, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(isSafeProfilePicture(php).ok, false);
  const jsp = dataUrl("image/jpeg", [0x3c, 0x25, 0x40, 0x70, 0x61, 0x67, 0x65, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(isSafeProfilePicture(jsp).ok, false);
});

test("rejects malformed base64, empty payloads and non-strings", () => {
  assert.equal(isSafeProfilePicture("data:image/png;base64,!!!!").ok, false);
  assert.equal(isSafeProfilePicture("data:image/png;base64,").ok, false);
  assert.equal(isSafeProfilePicture(12345).ok, false);
  assert.equal(isSafeProfilePicture({}).ok, false);
});

test("rejects oversized images (decoded bytes > 2 MB)", () => {
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1).fill(0x89);
  big[1] = 0x50;
  big[2] = 0x4e;
  big[3] = 0x47;
  const url = dataUrl("image/png", big);
  const result = isSafeProfilePicture(url);
  assert.equal(result.ok, false);
  assert.match(result.error, /at most 2 MB/);
});

test("rejects http:// (non-https) URLs", () => {
  assert.equal(isSafeProfilePicture("http://evil.example/x.png").ok, false);
  assert.equal(isSafeProfilePicture("https://evil.example/x.png").ok, true);
});

// ═══════════════════════════════════════════════════════════════════
// Convenience wrappers
// ═══════════════════════════════════════════════════════════════════

test("isSafeProfilePictureUrl / sanitizeProfilePicture wrappers", () => {
  const good = dataUrl("image/png", PNG_BYTES);
  assert.equal(isSafeProfilePictureUrl(good), true);
  assert.equal(isSafeProfilePictureUrl("data:image/svg+xml;base64,PHN2Zz4="), false);
  assert.equal(isSafeProfilePictureUrl("javascript:alert(1)"), false);
  assert.equal(sanitizeProfilePicture(good), good);
  assert.equal(sanitizeProfilePicture(""), null);
  assert.equal(sanitizeProfilePicture("javascript:alert(1)"), null);
});

test("ALLOWED_IMAGE_MIME is exactly the raster allow-list", () => {
  assert.deepEqual(
    [...ALLOWED_IMAGE_MIME].sort(),
    ["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"],
  );
  assert.ok(!ALLOWED_IMAGE_MIME.has("image/svg+xml"));
});
