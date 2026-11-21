// src/lib/security/bearerToken.ts
//
// The two machine-to-machine auth primitives, in one place so no route grows
// its own (and subtly wrong) version.
//
// WHY CONSTANT TIME: comparing a presented token to a configured secret with
// === leaks the answer through response timing. timingSafeEqual avoids that.
// It also requires equal-length buffers, so the length is checked first — an
// unequal length cannot be a valid token, and bailing out early reveals
// nothing about the secret bytes.

import { timingSafeEqual } from "node:crypto";

/** The token from an "Authorization: Bearer <token>" header, or "". */
export function readBearerToken(header: string | null | undefined): string {
  if (!header) return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

/** Constant-time string equality. An empty string never matches. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
