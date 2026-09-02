import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const bannerLib = read("src/lib/banners.ts");
const selectRoute = read("src/app/api/user/banner/select/route.ts");
const listRoute = read("src/app/api/user/banners/route.ts");
const publicRoute = read("src/app/api/user/public-profile/route.ts");
const customizationRoute = read("src/app/api/user/profile-customization/route.ts");
const migration = read("src/db/migrations/0135_official_profile_banners.sql");

test("banner selection requires authentication and server-side ownership", () => {
  assert.match(selectRoute, /await\s+auth\(\)/);
  assert.match(selectRoute, /selectBanner\(userId, body\?\.bannerKey\)/);
  assert.match(bannerLib, /eq\(banners\.enabled, true\)/);
  assert.match(bannerLib, /eq\(userBanners\.userId, appUser\.id\)/);
  assert.match(bannerLib, /eq\(userBanners\.bannerKey, key\)/);
  assert.match(bannerLib, /You do not own this banner/);
});

test("banner selection supports only JSON null for unequip", () => {
  assert.match(bannerLib, /if \(bannerKey === null\)/);
  assert.match(bannerLib, /set\(\{ selectedBanner: null \}\)/);
  assert.match(bannerLib, /Invalid banner key/);
});

test("banner ownership grants are idempotent", () => {
  assert.match(bannerLib, /onConflictDoNothing\(\{[\s\S]*target: \[userBanners\.userId, userBanners\.bannerKey\]/);
  assert.match(migration, /UNIQUE \("user_id", "banner_key"\)/);
  assert.match(migration, /ON CONFLICT \("key"\) DO NOTHING/);
});

test("effective banners fall back when catalog, enabled state, or ownership is invalid", () => {
  assert.match(bannerLib, /const catalog = await getBannerByKey\(appUser\.selectedBanner\)/);
  assert.match(bannerLib, /if \(!catalog\) return null/);
  assert.match(bannerLib, /return owned\.length \? catalog\.key : null/);
  assert.match(publicRoute, /resolveSelectedBannerKey\(clerkId\)/);
  assert.doesNotMatch(publicRoute, /userBanners/);
});

test("authenticated banner listing exposes owned catalog metadata only", () => {
  assert.match(listRoute, /await\s+auth\(\)/);
  assert.match(listRoute, /ownedBanners/);
  assert.match(bannerLib, /innerJoin\(banners, eq\(userBanners\.bannerKey, banners\.key\)\)/);
  assert.match(bannerLib, /row\.banner\?\.enabled/);
  assert.match(bannerLib, /assetUrl: bannerAssetUrl\(row\.bannerKey\)/);
});

test("legacy arbitrary profile banner writes are rejected and storage remains compatible", () => {
  assert.match(customizationRoute, /hasOwnProperty\.call\(body, "profileBanner"\)/);
  assert.match(customizationRoute, /Use the official banner picker/);
  assert.match(migration, /profile_banner.*retained for compatibility/s);
  assert.match(migration, /not converted into official ownership/s);
});
