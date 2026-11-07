// src/lib/portal/framing.ts
//
// PURE CSP framing policy for the portal export surface (`/play/<gameKey>`).
//
// ── WHY A SECOND POLICY ───────────────────────────────────────────────────
//
// The global policy in src/proxy.ts is `frame-ancestors 'self'` +
// `X-Frame-Options: SAMEORIGIN`. The platform embed policy
// (src/lib/platform/framing.ts) relaxes `/embed/*` to the platform allowlist —
// a private, token-authenticated surface minted server-to-server.
//
// A portal is a different thing: a public page a stranger's browser loads in an
// iframe. It therefore gets its own allowlist, `GRYND_PORTAL_FRAME_ORIGINS`,
// and its own path space (`/play/*`). Keeping them separate is the point: a
// portal origin can never frame an authenticated surface, and a platform origin
// can never frame a public one.
//
// The wildcard rule is the interesting part. Portals serve their games from
// rotating subdomains (CrazyGames uses `*.crazygames.com`), so an exact-origin
// list cannot work, while the platform parser rejects wildcards on purpose. This
// parser accepts exactly one shape — `https://*.example.com`, i.e. a wildcard
// only as the LEFTMOST label, only over a hostname with a real registrable
// domain — and rejects everything else, including a bare `*`, `https://*`,
// `https://*.com`, and `*.example.com` in any other position.

import { isPortalExportGame } from "./catalog";

export const PORTAL_FRAME_ORIGINS_ENV = "GRYND_PORTAL_FRAME_ORIGINS";

/** `/play` — the portal surface, and nothing else. */
export const PORTAL_PLAY_PREFIX = "/play";

/**
 * The portal surface's two shapes:
 *
 *   /play/<gameKey>              the lobby (practice entry point)
 *   /play/<gameKey>/<matchId>    the board that practice opens
 *
 * The second shape is why the first click no longer leaves the framable path:
 * three of the four games navigate to their board after "Play vs AI", and that
 * board used to live only on /casino/<game>/<id>, whose policy is
 * `frame-ancestors 'self'` — i.e. a portal frame went blank at the first move.
 * The match segment is opaque: it is validated by charset and length only, and
 * then by the game's own API (which authorises by seat).
 */
const PORTAL_PLAY_PATTERN = /^\/play\/([a-z0-9-]+)(?:\/([A-Za-z0-9._~-]{1,64}))?\/?$/;

/** Parse a portal path. Returns null for anything that is not the surface. */
export function portalPlayRoute(
  pathname: unknown,
): { gameKey: string; matchId: string | null } | null {
  if (typeof pathname !== "string") return null;
  const match = PORTAL_PLAY_PATTERN.exec(pathname);
  if (!match) return null;

  const gameKey = match[1];
  if (!isPortalExportGame(gameKey)) return null;

  const matchId = match[2] ?? null;
  // `.` and `..` are path syntax, not ids, and must never reach the board.
  if (matchId === "." || matchId === "..") return null;

  return { gameKey, matchId };
}

/** True for the portal game surface only (lobby or its board). */
export function isPortalPlayPath(pathname: unknown): boolean {
  return portalPlayRoute(pathname) !== null;
}

/** The exported game a portal path belongs to, or null. */
export function portalGameKeyFromPath(pathname: unknown): string | null {
  return portalPlayRoute(pathname)?.gameKey ?? null;
}

/**
 * Games with a BOARD route under /play. Battleship is absent on purpose: its
 * practice match renders inside the lobby page, so it never needs a second
 * framable path.
 */
export const PORTAL_MATCH_GAMES: readonly string[] = [
  "tic-tac-toe",
  "dominoes",
  "odds",
  "solitaire-duel",
];

export function hasPortalMatchRoute(gameKey: unknown): boolean {
  return typeof gameKey === "string" && PORTAL_MATCH_GAMES.includes(gameKey);
}

/**
 * One allowlist entry, or null.
 *
 * Accepted:  https://itch.io   https://html.itch.zone   https://*.crazygames.com
 * Rejected:  http://…, any path/query/fragment/credentials, a bare `*`,
 *            `https://*`, `https://*.com`, `https://foo.*.com`, `https://*.co.uk`
 */
export function normalizePortalFrameOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;

  const wildcard = raw.startsWith("https://*.");
  const host = wildcard ? raw.slice("https://*.".length) : raw.replace(/^https:\/\//, "");

  // A hostname, nothing more: no scheme leftovers, path, port, query, fragment,
  // credentials or further wildcards.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return null;
  }
  if (host.includes("*")) return null;
  // The only colon allowed is the one in `https://`; a port or a second scheme
  // separator means this is not a bare origin.
  if (raw.indexOf(":") !== 5 || raw.lastIndexOf(":") !== 5) return null;
  if (!raw.startsWith("https://")) return null;

  // `*.example.com` must still name a real registrable domain: a wildcard over a
  // single label (`*.com`) would allow every site on the internet.
  const labels = host.split(".");
  if (labels.length < 2) return null;
  // IP literals are never a portal host.
  if (/^\d+$/.test(labels[labels.length - 1])) return null;

  return wildcard ? `https://*.${host}` : `https://${host}`;
}

/** Parse the comma-separated env value. Invalid and duplicate entries are dropped. */
export function parsePortalFrameOrigins(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const origins: string[] = [];
  for (const part of raw.split(",")) {
    const origin = normalizePortalFrameOrigin(part);
    if (origin && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/** The configured allowlist, or [] when unset. */
export function getPortalFrameOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return parsePortalFrameOrigins(env[PORTAL_FRAME_ORIGINS_ENV]);
}

/**
 * `frame-ancestors` for the portal surface. With nothing configured the result
 * is `'self'`, i.e. the page stays unframable — a forgotten env var must never
 * open the surface to everyone.
 */
export function buildPortalFrameAncestors(origins: readonly string[]): string {
  const unique = origins.filter(
    (origin): origin is string => typeof origin === "string" && Boolean(normalizePortalFrameOrigin(origin)),
  );
  if (unique.length === 0) return "'self'";
  return [...new Set(unique)].join(" ");
}

type HeaderBag = {
  headers: {
    get(name: string): string | null;
    set(name: string, value: string): void;
    delete(name: string): void;
  };
};

function replaceFrameAncestors(csp: string, ancestors: string): string {
  const directive = `frame-ancestors ${ancestors}`;
  if (/frame-ancestors\s+[^;]+;?/.test(csp)) {
    return csp.replace(/frame-ancestors\s+[^;]+;?/, `${directive};`);
  }
  return `${csp.replace(/;\s*$/, "")}; ${directive};`;
}

/**
 * Apply the portal framing policy. Only `/play/<exported game>` responses are
 * touched, and only when at least one portal origin is configured:
 *
 *   · `X-Frame-Options` is removed (SAMEORIGIN would block the portal frame in
 *     browsers that still honour XFO; `frame-ancestors` is the real control);
 *   · `frame-ancestors` is replaced with the portal allowlist;
 *   · the response advertises that it is intentionally framable.
 *
 * No other directive changes, and no other path is touched.
 */
export function applyPortalFramePolicy(
  response: HeaderBag,
  pathname: unknown,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!isPortalPlayPath(pathname)) return;

  const origins = getPortalFrameOrigins(env);
  if (origins.length === 0) return; // not framable: keep 'self' + SAMEORIGIN

  response.headers.delete("X-Frame-Options");

  const ancestors = buildPortalFrameAncestors(origins);
  const csp = response.headers.get("Content-Security-Policy");
  response.headers.set(
    "Content-Security-Policy",
    csp ? replaceFrameAncestors(csp, ancestors) : `frame-ancestors ${ancestors};`,
  );

  // Lets the portal's own tooling (and ours) confirm the policy on purpose.
  response.headers.set("X-Grynd-Portal-Frame", "allowed");
}
