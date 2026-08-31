/**
 * Official Grynd icon system — optional DATABASE-backed checks.
 *
 * These assert the catalog gate against a REAL Postgres database (read-only):
 *   * the official default icon exists in the catalog and is enabled
 *   * unknown keys do NOT resolve through the catalog (null)
 *   * getEnabledIconKeys() exposes the default
 *
 * They are SKIPPED automatically when DATABASE_URL is not set, so the default
 * `npm test` run passes in environments without a database. The server's
 * authoritative equip gate (selectIcon) additionally enforces ownership and
 * never accepts arbitrary URLs — that write path is not exercised here to
 * avoid mutating a live DB; the pure resolver in tests/iconAssets.test.mjs
 * proves arbitrary URLs can never become an asset src.
 *
 * Run: node --import tsx --test tests/icons-db.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_ICON_KEY } from "../src/lib/iconAssets.ts";
import {
  getIconByKey,
  getEnabledIconKeys,
} from "../src/lib/icons.ts";

const hasDb = Boolean(process.env.DATABASE_URL);

test(
  "the official default icon exists in the catalog and is enabled",
  { skip: !hasDb && "DATABASE_URL not set" },
  async () => {
    const icon = await getIconByKey(DEFAULT_ICON_KEY);
    assert.ok(icon, "default icon must exist in the catalog");
    assert.equal(icon.key, "default");
    assert.equal(icon.enabled, true);
    assert.ok(icon.assetPath.startsWith("/icons/"), "asset path stays inside /icons");
  },
);

test(
  "unknown / arbitrary keys do not resolve through the catalog",
  { skip: !hasDb && "DATABASE_URL not set" },
  async () => {
    const bogus = await getIconByKey("https://evil.example/x.png");
    assert.equal(bogus, null);
    const nonsense = await getIconByKey("not-a-real-icon-zzz");
    assert.equal(nonsense, null);
  },
);

test(
  "getEnabledIconKeys exposes the official default icon",
  { skip: !hasDb && "DATABASE_URL not set" },
  async () => {
    const keys = await getEnabledIconKeys();
    assert.ok(keys.has(DEFAULT_ICON_KEY), "default icon must be enabled");
  },
);