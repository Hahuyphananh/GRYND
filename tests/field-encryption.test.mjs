/**
 * Field-level encryption — unit tests for src/lib/security/fieldEncryption.ts
 *
 *   node --import tsx --test tests/field-encryption.test.mjs
 *
 * Covers: round-trip, random-IV uniqueness, null/empty semantics, legacy
 * plaintext passthrough, tamper-evidence, and the safe-display fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  encryptField,
  decryptField,
  decryptFieldSafe,
  isEncrypted,
  FIELD_ENC_PREFIX,
} from "../src/lib/security/fieldEncryption.ts";

process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 0x2a).toString("base64");

test("encrypt then decrypt round-trips", () => {
  const secret = "Please help, my account was charged twice: card 4242.";
  const stored = encryptField(secret);
  assert.ok(stored);
  assert.ok(stored.startsWith(FIELD_ENC_PREFIX));
  // The plaintext must never appear in the stored blob.
  assert.ok(!stored.includes("4242"));
  assert.equal(decryptField(stored), secret);
});

test("same plaintext produces different ciphertexts (random IV)", () => {
  const a = encryptField("identical message");
  const b = encryptField("identical message");
  assert.notEqual(a, b);
  assert.equal(decryptField(a), "identical message");
  assert.equal(decryptField(b), "identical message");
});

test("null and empty input stay null", () => {
  assert.equal(encryptField(null), null);
  assert.equal(encryptField(undefined), null);
  assert.equal(encryptField(""), null);
  assert.equal(decryptField(null), null);
  assert.equal(decryptFieldSafe(null), null);
});

test("legacy plaintext rows pass through untouched", () => {
  const legacy = "stored before encryption existed";
  assert.equal(isEncrypted(legacy), false);
  assert.equal(decryptField(legacy), legacy);
  assert.equal(decryptFieldSafe(legacy), legacy);
});

test("tampered ciphertext fails closed (null), safe variant shows marker", () => {
  const stored = encryptField("original content");
  const flipped = stored.slice(0, -4) + (stored.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.equal(decryptField(flipped), null);
  assert.equal(decryptFieldSafe(flipped), "[unreadable]");
  assert.equal(decryptFieldSafe(flipped, "(corrupt)"), "(corrupt)");
});

test("garbage blob without prefix is treated as legacy text", () => {
  assert.equal(isEncrypted("just text"), false);
  assert.equal(decryptField("just text"), "just text");
});

test("truncated enc:v1 blob cannot crash the reader", () => {
  assert.equal(decryptField(FIELD_ENC_PREFIX + "c2hvcnQ="), null);
});
