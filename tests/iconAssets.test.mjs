/**
 * Official Grynd icon system — pure asset-resolver tests.
 *
 * Covers the resolver contract that guarantees an avatar is ALWAYS an
 * official icon derived from a catalog key — never an arbitrary user-supplied
 * URL:
 *   * valid keys resolve to /icons/<key>.<ext> (the official asset dir)
 *   * malformed / null / unknown keys fall back to the official default icon
 *   * arbitrary URLs (http/https/data/javascript/..) can never be echoed
 *     into an <img> src — isIconKey rejects them and iconAssetUrl coerces
 *     them to the default.
 *   * the default icon is always resolvable.
 *
 * Pure functions only (no DB), so this runs in any environment.
 *
 * Run: node --import tsx --test tests/iconAssets.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ICON_KEY,
  ICON_ASSET_DIR,
  ICON_ASSET_EXT,
  isIconKey,
  iconAssetUrl,
  defaultIconAssetUrl,
  resolveDisplayIconKey,
} from "../src/lib/iconAssets.ts";

// ═══════════════════════════════════════════════════════════════════
// isIconKey — key format validation
// ═══════════════════════════════════════════════════════════════════

test("accepts well-formed official icon keys", () => {
  for (const good of [
    "default",
    "rare_flame",
    "gold-star",
    "grynd.core.1",
    "a".repeat(120),
  ]) {
    assert.equal(isIconKey(good), true, `${good} should be a valid key`);
  }
});

test("rejects malformed / arbitrary keys and non-strings", () => {
  for (const bad of [
    "",
    " ",
    "UPPERCASE", // keys are lowercase
    "two words",
    "key\nnewline",
    123,
    null,
    undefined,
    {},
    "a".repeat(121), // exceeds VARCHAR(120)
  ]) {
    assert.equal(isIconKey(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("rejects path traversal / scheme smuggling", () => {
  assert.equal(isIconKey("../default"), false);
  assert.equal(isIconKey("../../etc/passwd"), false);
  assert.equal(isIconKey("/etc/passwd"), false);
  assert.equal(isIconKey("https://evil.example/x.png"), false);
  assert.equal(isIconKey("data:image/png;base64,AAAA"), false);
  assert.equal(isIconKey("javascript:alert(1)"), false);
  assert.equal(isIconKey("default.webp/.."), false);
});

// ═══════════════════════════════════════════════════════════════════
// iconAssetUrl — official asset resolution
// ═══════════════════════════════════════════════════════════════════

test("valid key resolves to /icons/<key>.<ext>", () => {
  assert.equal(iconAssetUrl("default"), `${ICON_ASSET_DIR}/default.${ICON_ASSET_EXT}`);
  assert.equal(iconAssetUrl("rare_flame"), `${ICON_ASSET_DIR}/rare_flame.${ICON_ASSET_EXT}`);
});

test("invalid/null/unknown keys fall back to the official default icon", () => {
  for (const bad of [null, undefined, "", "UPPERCASE", 42, "NOT a key"]) {
    assert.equal(
      iconAssetUrl(bad),
      defaultIconAssetUrl(),
      `${JSON.stringify(bad)} must resolve to the default icon`,
    );
    assert.equal(iconAssetUrl(bad), `${ICON_ASSET_DIR}/${DEFAULT_ICON_KEY}.${ICON_ASSET_EXT}`);
  }
});

test("arbitrary URLs can NEVER be echoed as an asset src", () => {
  // Even if a caller passes a full URL, the resolver coerces it to the
  // official default — it is never returned/rendered as a live <img> src.
  for (const attempt of [
    "https://evil.example/x.png",
    "http://evil.example/avatar.jpg",
    "data:image/png;base64,AAAA",
    "javascript:alert(document.cookie)",
    "/absolute/path.png",
    "//double-slash.example/x.png",
  ]) {
    assert.equal(isIconKey(attempt), false);
    const resolved = iconAssetUrl(attempt);
    assert.equal(resolved, defaultIconAssetUrl());
    assert.ok(resolved.startsWith(ICON_ASSET_DIR), "resolved path stays inside /icons");
    assert.ok(!resolved.startsWith("http"), "never returns an external URL");
    assert.ok(!resolved.startsWith("data:"), "never returns a data URL");
  }
});

test("resolveDisplayIconKey coerces stored junk to the default", () => {
  assert.equal(resolveDisplayIconKey("default"), "default");
  assert.equal(resolveDisplayIconKey("rare_flame"), "rare_flame");
  assert.equal(resolveDisplayIconKey(null), DEFAULT_ICON_KEY);
  assert.equal(resolveDisplayIconKey("https://evil.example/x.png"), DEFAULT_ICON_KEY);
  assert.equal(resolveDisplayIconKey(""), DEFAULT_ICON_KEY);
});

test("the default icon is always resolvable to the official asset", () => {
  assert.equal(DEFAULT_ICON_KEY, "default");
  assert.equal(defaultIconAssetUrl(), `${ICON_ASSET_DIR}/default.${ICON_ASSET_EXT}`);
});