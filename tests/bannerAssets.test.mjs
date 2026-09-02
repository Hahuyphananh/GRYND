import test from "node:test";
import assert from "node:assert/strict";
import {
  BANNER_ASSET_DIR,
  BANNER_ASSET_EXT,
  bannerAssetUrl,
  isBannerKey,
  normalizeBannerKey,
  resolveDisplayBannerKey,
  isTrustedBannerAssetUrl,
} from "../src/lib/bannerAssets.ts";

test("accepts normalized official banner keys", () => {
  assert.equal(isBannerKey("neon-grid"), true);
  assert.equal(normalizeBannerKey(" NEON-GRID "), "neon-grid");
  assert.equal(resolveDisplayBannerKey("neon-grid"), "neon-grid");
});

test("rejects malformed keys, URLs, filenames, paths, and ids", () => {
  for (const value of [
    "",
    "not a key",
    "../neon-grid",
    "/banners/neon-grid.webp",
    "https://evil.example/banner.webp",
    "javascript:alert(1)",
    "1",
    42,
    null,
    undefined,
  ]) {
    assert.equal(normalizeBannerKey(value), null, `${String(value)} must be rejected`);
    assert.equal(bannerAssetUrl(value), null, `${String(value)} must not resolve`);
  }
});

test("resolves only the trusted official asset path", () => {
  assert.equal(bannerAssetUrl("neon-grid"), `${BANNER_ASSET_DIR}/neon-grid.${BANNER_ASSET_EXT}`);
  assert.equal(isTrustedBannerAssetUrl("/banners/neon-grid.webp"), true);
  assert.equal(isTrustedBannerAssetUrl("https://evil.example/banner.webp"), false);
  assert.equal(isTrustedBannerAssetUrl("/banners/other.webp"), false);
});
