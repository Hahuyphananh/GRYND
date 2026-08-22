// src/lib/auth/totp.ts
// Native TOTP (RFC 6238) for the admin second factor. Uses only Node's crypto
// so we don't need otpauth/speakeasy or Clerk's paid MFA feature.

import crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Generate a random base32 secret suitable for authenticator apps. */
export function generateBase32Secret(bytes = 20): string {
  const buf = crypto.randomBytes(bytes);
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = "";
  for (const ch of clean) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val === -1) throw new Error("Invalid base32 secret");
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function computeHotp(secret: string, counter: number, digits = 6): string {
  const key = base32Decode(secret);
  const counterBuf = Buffer.alloc(8);
  // Counters fit in 32 bits until ~year 4095, so the upper 4 bytes stay zero.
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

export function generateTotp(
  secret: string,
  date = new Date(),
  period = 30,
  digits = 6,
): string {
  const counter = Math.floor(date.getTime() / 1000 / period);
  return computeHotp(secret, counter, digits);
}

/** Verify a 6-digit token with a ±`window` time-step tolerance. */
export function verifyTotp(secret: string, token: string, window = 1): boolean {
  if (!secret || !/^\d{6}$/.test(token)) return false;
  const period = 30;
  const counter = Math.floor(Date.now() / 1000 / period);
  for (let i = -window; i <= window; i++) {
    if (computeHotp(secret, counter + i) === token) return true;
  }
  return false;
}

export function buildOtpauthUrl(
  secret: string,
  label = "GRYND Admin",
  issuer = "GRYND",
): string {
  const encLabel = encodeURIComponent(label);
  const encIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${encLabel}?secret=${secret}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`;
}
