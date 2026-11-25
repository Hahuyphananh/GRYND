// src/lib/solitaire-duel/friendChallenge.ts
//
// CLIENT-SAFE half of the friend-challenge link: how a code is recognised,
// normalised and turned into a URL. Imports nothing from node, so the panel and
// the /duel landing page can use it without pulling the server store into the
// browser bundle. Code GENERATION lives in ./inviteCodes.ts (node:crypto).
//
// The link is `/duel/<CODE>` on purpose: it is short enough to paste into
// Discord without wrapping, and it says what it is. The code is not the match
// id — a match id is a uuid and, more importantly, a joinable-by-anyone string
// would make every private duel public. A code only ever names a WAITING
// private lobby; once the second seat is taken it seats nobody.

import { getSiteUrl } from "../siteUrl";

/**
 * 32 unambiguous characters. "I", "O", "0" and "1" are deliberately absent:
 * a code is read off one screen and typed into another, and those four are the
 * pairs people get wrong. 32 is also a power of two, so `byte % 32` over a
 * uniform byte is unbiased (see ./inviteCodes.ts).
 */
export const FRIEND_CHALLENGE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 8 characters over that alphabet ≈ 40 bits — plenty for a 7-day seat. */
export const FRIEND_CHALLENGE_CODE_LENGTH = 8;

/** How long a link may seat a second player. */
export const FRIEND_CHALLENGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The public path prefix. One place, so the page and the API cannot drift. */
export const FRIEND_CHALLENGE_PATH_PREFIX = "/duel";

/**
 * A user-supplied code reduced to its canonical form, or null.
 *
 * Accepts what people actually paste: lower case, spaces, dashes, and the whole
 * URL (`https://…/duel/ABCD2345`). Normalisation is deliberately generous on
 * input and strict on output — the canonical form is upper case with no
 * separators, which is what is stored and compared.
 */
export function normalizeFriendChallengeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;

  let candidate = value.trim();
  // A pasted URL: keep only the last path segment.
  if (candidate.includes("/")) {
    const segments = candidate.split(/[?#]/)[0].split("/").filter(Boolean);
    candidate = segments[segments.length - 1] ?? "";
  }

  const cleaned = candidate.toUpperCase().replace(/[\s\-_]/g, "");
  if (cleaned.length !== FRIEND_CHALLENGE_CODE_LENGTH) return null;
  for (const char of cleaned) {
    if (!FRIEND_CHALLENGE_ALPHABET.includes(char)) return null;
  }
  return cleaned;
}

export function isFriendChallengeCode(value: unknown): boolean {
  return normalizeFriendChallengeCode(value) !== null;
}

/**
 * The path a challenge is shared as, or null for a code that cannot be one.
 *
 * Returning null rather than building `/duel/undefined` means a caller cannot
 * render a broken link when a bad code reaches it.
 */
export function friendChallengePath(code: unknown): string | null {
  const normalized = normalizeFriendChallengeCode(code);
  return normalized ? `${FRIEND_CHALLENGE_PATH_PREFIX}/${normalized}` : null;
}

/** The absolute URL a friend receives. */
export function friendChallengeUrl(code: unknown): string | null {
  const path = friendChallengePath(code);
  return path ? `${getSiteUrl()}${path}` : null;
}

/**
 * Where a challenge can be sent to, with the message PRE-FILLED.
 *
 * WhatsApp accepts the whole message in the URL, so the friend lands in the
 * compose box with the link already in it. Discord has no prefilled-message URL
 * (its web app deliberately cannot be driven that way), so the honest offer is
 * "copy the message, then open Discord" — the panel does exactly that, and
 * `discordComposerUrl` is just where it opens.
 *
 * The message, not the bare URL, is what gets shared: an unexplained
 * `/duel/ABCD2345` reads like spam in a group chat.
 */
export const DISCORD_COMPOSER_URL = "https://discord.com/channels/@me";

export type FriendChallengeShareLinks = {
  /** wa.me compose URL, message and link already filled in. */
  whatsapp: string;
  /** Discord's own DM surface — the message must be copied separately. */
  discord: string;
};

export function friendChallengeShareLinks(
  code: unknown,
): FriendChallengeShareLinks | null {
  const message = friendChallengeMessage(code);
  if (!message) return null;
  return {
    whatsapp: `https://wa.me/?text=${encodeURIComponent(message)}`,
    discord: DISCORD_COMPOSER_URL,
  };
}

/** What the copied message says. Kept with the code so both cannot drift. */
export function friendChallengeMessage(
  code: unknown,
  { gameName = "Solitaire Duel" }: { gameName?: string } = {},
): string | null {
  const url = friendChallengeUrl(code);
  if (!url) return null;
  return `Race me on ${gameName} — same deal, head to head: ${url}`;
}
