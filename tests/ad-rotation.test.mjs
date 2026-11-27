/**
 * Provider rotation — integration contract.
 *
 * The fallback chain is sequential, so a fixed priority means the first
 * configured provider wins every slot it can fill. These tests pin the rotation
 * that makes two eligible providers alternate instead:
 *
 *   1. the rotation is derived from the opportunity id and is stable for it,
 *   2. it only re-orders — never adds, drops or duplicates a provider,
 *   3. it is on by default and can be switched off explicitly,
 *   4. both the banner slot and the post-match player use it,
 *   5. an Adcash AUTOTAG zone id (`zt…`) is refused as a display zone.
 *
 * Run: npm run test:rotation (also part of npm run test:fallback)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  adRotationEnabled,
  rotateProviderOrder,
  rotatedProviderOrder,
  rotationOffset,
} from "../src/lib/ads/core/order.ts";
import { adcashZoneId, isAdcashAutotagZoneId } from "../src/lib/adcash/config.ts";

const read = (path) => fs.readFileSync(path, "utf8");
const CLIENT = read("src/components/ads/BannerSlotClient.tsx");
const PLAYER = read("src/components/ads/PostMatchVideoAd.tsx");

const ALL = ["hilltop", "exoclick", "adcash"];
const PAIR = ["hilltop", "adcash"];

function withEnv(values, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── Rotation is stable and bounded ────────────────────────────────────────

test("rotation offset is deterministic, in range, and degenerate-safe", () => {
  assert.equal(rotationOffset("banner:home:abc", 3), rotationOffset("banner:home:abc", 3));
  assert.notEqual(rotationOffset("banner:home:abc", 3), -1);

  for (const key of ["", "a", "banner:home:x", "video:match-1"]) {
    const offset = rotationOffset(key, 3);
    assert.ok(offset >= 0 && offset < 3, `${key} offset in range`);
  }

  assert.equal(rotationOffset("", 3), 0, "an empty key does not turn the list");
  assert.equal(rotationOffset("anything", 1), 0, "one provider cannot rotate");
  assert.equal(rotationOffset("anything", 0), 0);
});

test("rotation re-orders only: same members, same length, input untouched", () => {
  const source = Object.freeze([...ALL]);
  for (let offset = 0; offset < 8; offset += 1) {
    const rotated = rotateProviderOrder(source, offset);
    assert.equal(rotated.length, ALL.length);
    assert.deepEqual([...rotated].sort(), [...ALL].sort(), "no provider added or dropped");
    assert.equal(new Set(rotated).size, rotated.length, "no duplicates");
  }
  assert.deepEqual([...source], ALL, "the frozen input is not mutated");

  assert.deepEqual(rotateProviderOrder([], 5), []);
  assert.deepEqual(rotateProviderOrder(["hilltop"], 5), ["hilltop"]);
  assert.deepEqual(rotateProviderOrder(ALL, 0), ALL);
  assert.deepEqual(rotateProviderOrder(ALL, 1), ["exoclick", "adcash", "hilltop"]);
  assert.deepEqual(rotateProviderOrder(ALL, 4), ["exoclick", "adcash", "hilltop"]);
  assert.deepEqual(rotateProviderOrder(ALL, -1), ["adcash", "hilltop", "exoclick"]);
});

test("the same opportunity always produces the same order", async () => {
  await withEnv({ NEXT_PUBLIC_ADS_ROTATION: undefined }, () => {
    const first = rotatedProviderOrder(ALL, "banner:home:7f3a");
    const second = rotatedProviderOrder(ALL, "banner:home:7f3a");
    assert.deepEqual(first, second, "a remount cannot reorder an in-flight chain");
  });
});

test("two eligible providers alternate across opportunities", async () => {
  await withEnv({ NEXT_PUBLIC_ADS_ROTATION: undefined }, () => {
    const firsts = new Set();
    for (let index = 0; index < 64; index += 1) {
      const order = rotatedProviderOrder(PAIR, `banner:home:doc-${index}`);
      assert.deepEqual([...order].sort(), [...PAIR].sort());
      firsts.add(order[0]);
    }
    assert.deepEqual(
      [...firsts].sort(),
      ["adcash", "hilltop"],
      "both providers must get to go first, or one is only ever a fallback",
    );
  });
});

test("rotation is on by default and can be switched off explicitly", async () => {
  await withEnv({ NEXT_PUBLIC_ADS_ROTATION: undefined }, () => {
    assert.equal(adRotationEnabled(), true);
  });

  await withEnv({ NEXT_PUBLIC_ADS_ROTATION: "false" }, () => {
    assert.equal(adRotationEnabled(), false);
    assert.deepEqual(
      rotatedProviderOrder(PAIR, "banner:home:doc-1"),
      PAIR,
      "the configured priority is kept exactly",
    );
  });

  await withEnv({ NEXT_PUBLIC_ADS_ROTATION: "TRUE " }, () => {
    assert.equal(adRotationEnabled(), true);
  });
});

// ── The two surfaces use it ───────────────────────────────────────────────

test("the banner slot and the post-match player rotate their chains", () => {
  assert.match(CLIENT, /rotatedProviderOrder\(allowed, id\)/);
  assert.match(PLAYER, /videoProviderChain\(opportunity\.id\)/);
});

// ── Autotag is refused ────────────────────────────────────────────────────

test("an Adcash AUTOTAG zone id is recognised and refused as a display zone", () => {
  assert.equal(isAdcashAutotagZoneId("zt2ub7mrao"), true);
  assert.equal(isAdcashAutotagZoneId(" ZT2UB7MRAO "), true);
  assert.equal(isAdcashAutotagZoneId("1234567"), false);
  assert.equal(isAdcashAutotagZoneId(""), false);

  withEnv({ NEXT_PUBLIC_ADCASH_ZONE_HOME: "zt2ub7mrao" }, () => {
    assert.equal(
      adcashZoneId("home"),
      null,
      "Autotag rotates pop-under/interstitial/push, so it must never run here",
    );
  });

  withEnv({ NEXT_PUBLIC_ADCASH_ZONE_HOME: "1234567" }, () => {
    assert.equal(adcashZoneId("home"), "1234567");
  });
});
