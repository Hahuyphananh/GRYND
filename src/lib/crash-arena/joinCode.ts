// src/lib/crash-arena/joinCode.ts
//
// Invite codes for PRIVATE Crash Arena tables (mirrors the poker private
// games' game codes). A code is 6 chars from an unambiguous alphabet —
// no 0/O, 1/I — stored uppercase, compared case-insensitively on join.

import crypto from "node:crypto";

/** Alphabet without ambiguous characters. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Length of a generated invite code. */
export const JOIN_CODE_LENGTH = 6;

/** Generate a fresh random invite code (cryptographically random). */
export function generateJoinCode(): string {
  const bytes = crypto.randomBytes(JOIN_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/** Normalize a user-supplied code: trim, uppercase, strip separators. */
export function normalizeJoinCode(code: string | null | undefined): string {
  if (!code) return "";
  return String(code).trim().toUpperCase().replace(/[\s-]/g, "");
}

/** Whether a normalized code has the expected shape. */
export function isValidJoinCode(code: string): boolean {
  return typeof code === "string" && /^[A-Z2-9]{4,12}$/.test(code);
}
