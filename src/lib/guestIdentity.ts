// src/lib/guestIdentity.ts
//
// PURE, dependency-free description of a GUEST player — the identity a
// signed-out visitor gets when they press "Play vs AI".
//
// WHY GUESTS EXIST: every free-practice (vs AI) mode is unrated — no wager, no
// pot, no trophies, no rating, no win counters (each game's settle step skips
// them when the match is flagged as an AI match). There is therefore nothing a
// guest can earn, so requiring a full account before a visitor can try a game
// against the bot is friction with no upside. Signed-in players are gated
// exactly as before; guests are only ever allowed into practice matches.
//
// THE ID: a guest is `guest_<uuid>`, signed into a cookie by
// src/lib/auth/guestSession.ts. It is deliberately NOT a Clerk id: every
// `user_*` lookup in the app (src/lib/seatIdentity.js, the rating/trophy
// settles, the age gate) keys off that prefix, so a guest can never be
// mistaken for a real account, can never hold a rating or a trophy, and can
// never be resolved to another player's data.
//
// Importable from client components (mirrors src/lib/iconAssets.ts).

/** Prefix that marks a synthetic guest id. Never produced by Clerk. */
export const GUEST_ID_PREFIX = "guest_";

/** Display name shown on every seat a guest occupies. */
export const GUEST_DISPLAY_NAME = "Guest";

/**
 * The guest's "pfp". A guest has no account, so it has no equipped icon in the
 * official catalog; the avatar layer renders a letter badge from the display
 * name instead (see <IconAvatar isGuest>), which shows as a "G".
 */
export const GUEST_AVATAR_LETTER = "G";

/** HttpOnly cookie carrying the signed guest id. */
export const GUEST_COOKIE = "grynd_guest";

/** 30 days — long enough that a returning visitor keeps the same guest seat. */
export const GUEST_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** Max accepted length of a raw guest id (defensive, mirrors cookie limits). */
const GUEST_ID_MAX_LENGTH = 64;

/**
 * True only for a well-formed synthetic guest id. Everything downstream uses
 * this instead of a `startsWith` check so a malformed cookie value can never
 * be forwarded into a query as an owner id.
 */
export function isGuestId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length <= GUEST_ID_PREFIX.length) return false;
  if (value.length > GUEST_ID_MAX_LENGTH) return false;
  if (!value.startsWith(GUEST_ID_PREFIX)) return false;
  return /^[A-Za-z0-9_-]+$/.test(value.slice(GUEST_ID_PREFIX.length));
}

/** The identity shape every seat renderer understands. */
export type SeatIdentityLike = {
  name: string | null;
  iconKey: string | null;
  nameColor: string | null;
  profileFrame: null;
  isGuest: boolean;
};

/** The seat identity for a guest seat (name "Guest", letter "G" avatar). */
export function guestSeatIdentity(): SeatIdentityLike {
  return {
    name: GUEST_DISPLAY_NAME,
    // No catalog key: the avatar renders the letter badge for a guest seat.
    iconKey: null,
    nameColor: null,
    profileFrame: null,
    isGuest: true,
  };
}
