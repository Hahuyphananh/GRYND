// src/lib/security/fieldEncryption.ts
//
// Field-level encryption at rest for sensitive user-supplied columns
// (contact-form messages, admin replies, player-report details).
//
// Threat model: the DATABASE is not the trust boundary. Anyone with direct
// SQL access (a dumped backup, a leaked read replica credential, a rogue
// admin querying psql) must not be able to read the raw values of these
// fields — they see only an opaque `enc:v1:` ciphertext blob.
//
// Design:
//   * AES-256-GCM with a random 12-byte IV per value (indistinguishable
//     ciphertexts for identical plaintexts) + a 16-byte auth tag, so stored
//     values are also tamper-evident.
//   * Key material NEVER appears in code, config files, or the repo. It is
//     read from the `FIELD_ENCRYPTION_KEY` environment variable
//     (base64-encoded 32 random bytes), set in Vercel/Render/Neon secrets,
//     not committed anywhere.
//   * Legacy pre-encryption rows are stored without the `enc:v1:` prefix;
//     decryptField passes them through untouched so nothing breaks during
//     the migration, and new writes are always encrypted.
//
// Generate the key with:  openssl rand -base64 32

import crypto from "node:crypto";

const KEY_ENV = "FIELD_ENCRYPTION_KEY";
export const FIELD_ENC_PREFIX = "enc:v1:";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new Error(
      `${KEY_ENV} is not set. Set it to a base64-encoded 32-byte key ` +
        `(generate with: openssl rand -base64 32) before enabling field encryption.`,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV} must decode to exactly 32 bytes (256 bits).`);
  }
  cachedKey = key;
  return key;
}

/** True when a valid 32-byte key is configured (used by framework-free cores). */
export function isFieldEncryptionConfigured(): boolean {
  const raw = process.env[KEY_ENV];
  if (!raw) return false;
  try {
    return Buffer.from(raw, "base64").length === 32;
  } catch {
    return false;
  }
}

export function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(FIELD_ENC_PREFIX);
}

/**
 * Encrypt a plaintext string for storage. Empty/null input stays null so
 * optional columns keep their NULL semantics. Throws when no key is
 * configured (fail-closed: never silently store plaintext when encryption
 * was requested).
 */
export function encryptField(
  plaintext: string | null | undefined,
): string | null {
  if (plaintext == null) return null;
  const text = String(plaintext);
  if (text.length === 0) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return FIELD_ENC_PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt a stored value. Legacy plaintext rows (no prefix) pass through.
 * Returns null when decryption fails (missing/wrong key, tampering,
 * corruption) — never throws.
 */
export function decryptField(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  if (!isEncrypted(value)) return value; // legacy pre-encryption row
  try {
    const buf = Buffer.from(value.slice(FIELD_ENC_PREFIX.length), "base64");
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Decrypt for display in admin/user UIs. Legacy plaintext passes through;
 * an encrypted value that fails to decrypt (tampered, or key rotated away)
 * shows the `fallback` marker instead of garbage or a crash.
 */
export function decryptFieldSafe(
  value: string | null | undefined,
  fallback = "[unreadable]",
): string | null {
  if (value == null) return null;
  if (!isEncrypted(value)) return value;
  return decryptField(value) ?? fallback;
}
