// src/lib/solitaire-duel/inviteCodes.ts
//
// SERVER-ONLY code generation for friend-challenge links. Separate from
// ./friendChallenge.ts so the client bundle never imports node:crypto.
//
// Entropy is `randomBytes`, exactly like the match seeds: a challenge code is a
// capability — holding it is what lets you sit down at that table — so it must
// not come from Math.random().

import { randomBytes } from "node:crypto";

import {
  FRIEND_CHALLENGE_ALPHABET,
  FRIEND_CHALLENGE_CODE_LENGTH,
} from "./friendChallenge";

/**
 * An 8-character code from the 32-character unambiguous alphabet.
 *
 * 256 % 32 === 0, so `byte % 32` is exactly uniform and no rejection sampling
 * is needed. The alphabet length is asserted below so a future edit that breaks
 * that property fails loudly instead of silently biasing the codes.
 */
export function generateFriendChallengeCode(
  random: (size: number) => Buffer = randomBytes,
): string {
  if (256 % FRIEND_CHALLENGE_ALPHABET.length !== 0) {
    throw new Error(
      "FRIEND_CHALLENGE_ALPHABET must divide 256 for unbiased modulo sampling",
    );
  }
  const bytes = random(FRIEND_CHALLENGE_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < FRIEND_CHALLENGE_CODE_LENGTH; i += 1) {
    code += FRIEND_CHALLENGE_ALPHABET[bytes[i] % FRIEND_CHALLENGE_ALPHABET.length];
  }
  return code;
}
