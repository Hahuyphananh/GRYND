// src/lib/portal/catalog.ts
//
// PORTAL EXPORTS — the pure, dependency-free description of what GRYND can hand
// to an external games portal, and in what shape.
//
// ── THE SHAPE, AND WHY ────────────────────────────────────────────────────
//
// Every GRYND game is server-authoritative: the board state lives in Postgres,
// moves are validated by API routes and, for multiplayer, relayed over
// Socket.IO. There is therefore no "bundle the game files into a zip" export:
// a static zip would contain no rules, no opponent and no saved progress.
//
// What CAN be exported is a per-game, playable URL plus a launcher page that
// frames it. That is the shape portals accept today:
//
//   · itch.io — an HTML5 zip whose index.html frames the game, or its
//     "embed from external site" field pointing at the same page.
//   · CrazyGames — "externally hosted (iframe)" is a documented submission mode;
//     the game URL is submitted and CrazyGames frames it.
//   · Poki — does NOT accept a framed site. Poki hosts the build and blocks
//     external requests by default, so a Poki submission needs a self-contained
//     port of the game with the Poki SDK inside it. This catalog marks Poki as
//     `upload-only` and the export explains that in its manifest; it does not
//     pretend a launcher is a Poki submission.
//
// ── WHICH GAMES ───────────────────────────────────────────────────────────
//
// Only the games a signed-out visitor can actually play. A portal player has no
// GRYND account and often no ability to sign in inside a third-party iframe, so
// a game that requires an account is not exportable.
//
// Two kinds qualify, and both are pinned by tests/portal-export.test.mjs:
//
//   · the guest practice games whose results are persisted
//     (GUEST_PRACTICE_GAME_KEYS on the server, mirrored by GUEST_GAME_LABELS on
//     the client) — these must ALWAYS be exportable; and
//   · a game whose practice mode accepts a guest even though it writes no guest
//     progress. Solitaire Duel is the one: its `create-ai` route goes through
//     `requirePracticePlayer({ create: true })`, so a signed-out visitor gets a
//     real (unrated, unpersisted) match. The test proves that by reading the
//     route, so a game cannot be added here on a claim alone.
//
// Nothing here touches match logic, settlement, ratings or rewards: an exported
// game is the same unrated practice game the app serves, at the same route.

/** One game that can be offered to an external portal. */
export type PortalExportGame = {
  /** Canonical game key — the same one guest practice results are stored under. */
  gameKey: string;
  /** Public name used in the manifest and the launcher's title. */
  name: string;
  /** The app's own practice page for this game. */
  route: string;
  /**
   * The chrome-free surface a portal actually loads (src/app/play/[gameKey]).
   * Same game component as `route`, with no site navbar, chat, quests, mascot,
   * splash, consent banner or site analytics — what a portal frame requires.
   */
  playRoute: string;
  /** Practice is unrated and needs no account — the only exportable mode today. */
  mode: "practice";
  /** Always false: a portal player is a guest. */
  requiresAccount: false;
};

/**
 * The closed export list. Adding a game here requires that its practice mode is
 * playable signed out — either because its results are written for guests, or
 * because it is a reviewed exception whose practice endpoint accepts a guest.
 * That is what makes the URL usable by a portal visitor.
 */
export const PORTAL_EXPORT_GAMES: readonly PortalExportGame[] = [
  {
    gameKey: "tic-tac-toe",
    name: "Ultimate Tic-Tac-Toe",
    route: "/casino/tic-tac-toe",
    playRoute: "/play/tic-tac-toe",
    mode: "practice",
    requiresAccount: false,
  },
  {
    gameKey: "dominoes",
    name: "Dominoes",
    route: "/casino/dominoes",
    playRoute: "/play/dominoes",
    mode: "practice",
    requiresAccount: false,
  },
  {
    gameKey: "battleship",
    name: "Battleship",
    route: "/casino/battleship",
    playRoute: "/play/battleship",
    mode: "practice",
    requiresAccount: false,
  },
  {
    gameKey: "odds",
    name: "Odds",
    route: "/casino/odds",
    playRoute: "/play/odds",
    mode: "practice",
    requiresAccount: false,
  },
  {
    // The reviewed exception: no guest-progress row, but practice is open to a
    // signed-out visitor (see the note above) and the board is a real route, so
    // a portal can frame the whole match.
    gameKey: "solitaire-duel",
    name: "Solitaire Duel",
    route: "/casino/solitaire-duel",
    playRoute: "/play/solitaire-duel",
    mode: "practice",
    requiresAccount: false,
  },
] as const;

export type PortalSlug = "itch" | "crazygames" | "poki";

/** How the portal expects to receive a game. */
export type PortalHosting = "upload-zip" | "external-url" | "both";

export type PortalSpec = {
  slug: PortalSlug;
  label: string;
  hosting: PortalHosting;
  /** SDK the portal requires from the GAME (null when it requires none). */
  sdk: string | null;
  /**
   * Origins that must be allowed in `frame-ancestors` for this portal to frame
   * the hosted game. Empty when the portal never frames us (Poki hosts the build).
   */
  frameAncestors: readonly string[];
  /** Where a developer submits the game. */
  submissionUrl: string;
  /** Facts that decide whether this portal is a realistic next step. */
  requirements: readonly string[];
};

export const PORTALS: Record<PortalSlug, PortalSpec> = {
  itch: {
    slug: "itch",
    label: "itch.io",
    // Both: an HTML5 zip whose entry frames the game, or the project's
    // "embed from external site" URL.
    hosting: "both",
    sdk: null,
    frameAncestors: ["https://itch.io", "https://html.itch.zone"],
    submissionUrl: "https://itch.io/game/new",
    requirements: [
      "No SDK is required; an HTML5 project (zip) or an external embed URL is accepted.",
      "The page must be framable by itch's HTML5 player, so html.itch.zone must appear in frame-ancestors.",
      "A cover image, screenshots, tags and a short description are required by the form.",
    ],
  },
  crazygames: {
    slug: "crazygames",
    label: "CrazyGames",
    hosting: "both",
    sdk: "CrazyGames HTML5 SDK v3",
    frameAncestors: ["https://www.crazygames.com", "https://*.crazygames.com"],
    submissionUrl: "https://developer.crazygames.com",
    requirements: [
      "Externally hosted (iframe) is a supported submission mode: submit the game URL instead of a zip.",
      "Externally hosted games earn only when the SDK v3 is integrated inside the game (init, gameplayStart/Stop, ads).",
      "The response must allow *.crazygames.com in frame-ancestors.",
      "Mobile support, immediate gameplay (no lobby wall) and a PEGI 12 content bar are required.",
    ],
  },
  poki: {
    slug: "poki",
    label: "Poki",
    hosting: "upload-zip",
    sdk: "Poki SDK",
    // Poki hosts the game files itself, so nothing frames a GRYND origin.
    frameAncestors: [],
    submissionUrl: "https://developers.poki.com/share",
    requirements: [
      "Poki hosts the build: a self-contained web build is uploaded, not a link to this site.",
      "External requests are blocked by default, so a hosted Next.js game cannot be submitted as-is.",
      "The Poki SDK (init, gameLoadingFinished, gameplayStart/Stop, commercialBreak) is mandatory.",
      "Initial download under 8 MB, a 16:9 canvas, and an application through Poki for Developers (hand-curated, limited access).",
    ],
  },
};

export const PORTAL_SLUGS: readonly PortalSlug[] = ["itch", "crazygames", "poki"];

/** Query parameter appended to the exported URL so the game can detect a portal. */
export const PORTAL_QUERY_PARAM = "portal";

/** Format marker written into every manifest. */
export const PORTAL_EXPORT_FORMAT = "grynd-portal-export";
export const PORTAL_EXPORT_VERSION = 1;

export function isPortalSlug(value: unknown): value is PortalSlug {
  return typeof value === "string" && (PORTAL_SLUGS as readonly string[]).includes(value);
}

export function getPortalSpec(slug: unknown): PortalSpec | null {
  return isPortalSlug(slug) ? PORTALS[slug] : null;
}

export function getPortalExportGame(gameKey: unknown): PortalExportGame | null {
  if (typeof gameKey !== "string") return null;
  return PORTAL_EXPORT_GAMES.find((game) => game.gameKey === gameKey) ?? null;
}

export function isPortalExportGame(gameKey: unknown): boolean {
  return getPortalExportGame(gameKey) !== null;
}

/**
 * The origin a game is published under. HTTPS only, an origin (optionally with a
 * deployment subpath), no credentials, query, fragment or wildcard — the same
 * standard the platform allowlist uses, so a typo cannot produce a launcher that
 * points at an attacker-controlled host.
 */
export function normalizePortalBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.hostname.includes("*")) return null;
  if (url.search || url.hash) return null;

  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/**
 * The URL a portal should load for one game: `<origin><playRoute>?portal=<slug>`.
 *
 * It points at the CHROME-FREE surface, not the app's own page: a portal frame
 * gets the game and nothing of the site around it, and the framing policy is
 * relaxed for `/play/*` alone. The query parameter is how the game and the SDK
 * bridge can tell a portal visit apart from a normal one. It carries nothing
 * identifying.
 */
export function portalGameUrl(input: {
  gameKey: string;
  baseUrl: string;
  portal: PortalSlug;
}): string | null {
  const game = getPortalExportGame(input.gameKey);
  const base = normalizePortalBaseUrl(input.baseUrl);
  if (!game || !base || !isPortalSlug(input.portal)) return null;
  return `${base}${game.playRoute}?${PORTAL_QUERY_PARAM}=${input.portal}`;
}

/** HTML-escape a value for text and attribute contexts. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type PortalExportManifest = {
  format: typeof PORTAL_EXPORT_FORMAT;
  version: number;
  generatedAt: string;
  portal: PortalSlug;
  portalLabel: string;
  hosting: PortalHosting;
  game: { key: string; name: string; route: string; playRoute: string; mode: "practice" };
  url: string;
  entry: "index.html";
  sdk: { required: boolean; name: string | null };
  frameAncestors: string[];
  requirements: string[];
};

/**
 * The submitter-facing description of one export. It deliberately contains no
 * secret, token, guest id or cookie name: it is meant to be uploaded, pasted
 * into a submission form or committed next to the build.
 */
export function buildExportManifest(input: {
  gameKey: string;
  portal: PortalSlug;
  baseUrl: string;
  generatedAt?: string;
}): PortalExportManifest | null {
  const game = getPortalExportGame(input.gameKey);
  const spec = getPortalSpec(input.portal);
  const url = portalGameUrl({
    gameKey: input.gameKey,
    baseUrl: input.baseUrl,
    portal: input.portal,
  });
  if (!game || !spec || !url) return null;

  return {
    format: PORTAL_EXPORT_FORMAT,
    version: PORTAL_EXPORT_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    portal: spec.slug,
    portalLabel: spec.label,
    hosting: spec.hosting,
    game: {
      key: game.gameKey,
      name: game.name,
      route: game.route,
      playRoute: game.playRoute,
      mode: game.mode,
    },
    url,
    entry: "index.html",
    sdk: { required: Boolean(spec.sdk), name: spec.sdk },
    frameAncestors: [...spec.frameAncestors],
    requirements: [...spec.requirements],
  };
}

/**
 * The launcher page: one full-viewport iframe pointing at the exported game.
 *
 * It carries NO SDK script on purpose. The Poki and CrazyGames SDKs are called
 * by the GAME, inside its own document; a wrapper frame cannot drive another
 * origin's SDK, and adding a CDN <script> here would only slow the page down or
 * fail where the CDN is blocked. The manifest states which SDK the game itself
 * still needs.
 */
export function buildLauncherHtml(input: {
  gameKey: string;
  portal: PortalSlug;
  baseUrl: string;
}): string | null {
  const game = getPortalExportGame(input.gameKey);
  const spec = getPortalSpec(input.portal);
  const url = portalGameUrl({
    gameKey: input.gameKey,
    baseUrl: input.baseUrl,
    portal: input.portal,
  });
  if (!game || !spec || !url) return null;

  const title = escapeHtml(`${game.name} — GRYND`);
  const src = escapeHtml(url);
  const label = escapeHtml(game.name);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="robots" content="noindex" />
    <title>${title}</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
        background: #000d1a;
        color: #9dd8ff;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
      }
      noscript {
        display: block;
        padding: 1.5rem;
        font-size: 0.875rem;
      }
    </style>
  </head>
  <body>
    <!-- ${escapeHtml(spec.label)} launcher for ${label}. The game itself runs at
         ${escapedUrlOrigin(url)} — this page only frames it, and the game's own
         route is what the manifest names. -->
    <iframe
      src="${src}"
      title="${label}"
      allow="fullscreen; autoplay; gamepad; clipboard-write"
      referrerpolicy="strict-origin-when-cross-origin"
      loading="eager"
    ></iframe>
    <noscript>This game needs JavaScript. Open ${src} directly.</noscript>
  </body>
</html>
`;
}

/** The origin of an absolute URL, for a comment in the launcher. */
function escapedUrlOrigin(url: string): string {
  try {
    return escapeHtml(new URL(url).origin);
  } catch {
    return "";
  }
}

/** Every file of one export, keyed by file name. */
export function buildExportFiles(input: {
  gameKey: string;
  portal: PortalSlug;
  baseUrl: string;
  generatedAt?: string;
}): Record<string, string> | null {
  const html = buildLauncherHtml(input);
  const manifest = buildExportManifest(input);
  if (!html || !manifest) return null;
  return {
    "index.html": html,
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
  };
}
