// src/lib/platform/config.ts
//
// PURE configuration for external platform embeds (Phase 5). No DB, no Next
// imports, no secrets in client bundles — every value here comes from the
// server environment.
//
// ── THE ALLOWLIST IS THE AUTHORITY ───────────────────────────────────────
//
// GRYND_PLATFORM_ALLOWLIST is a comma-separated list of `platform=origin`
// entries, e.g.
//
//   GRYND_PLATFORM_ALLOWLIST="crazygames=https://www.crazygames.com,itch=https://itch.io"
//
// A platform is only usable when BOTH its origin is listed and its per-platform
// secret is configured:
//
//   GRYND_PLATFORM_SECRET_CRAZYGAMES=<random 32+ byte secret>
//
// Nothing falls back to a wildcard: an unknown platform, a missing secret or a
// non-https origin disables embedding for that platform entirely. The same
// parsed origins feed the `frame-ancestors` policy for /embed/* in
// src/lib/platform/framing.ts, so the iframe allowlist and the server-side
// origin check cannot drift.
//
// ── GAMES ────────────────────────────────────────────────────────────────
//
// Only explicitly embedded games are allowed. Tic-Tac-Toe practice is the first
// (it is server-authoritative and unrated), and the list is closed on purpose:
// adding a game requires its own review of the guest/practice path.

export const EMBEDDED_GAME_KEYS = ["tic-tac-toe"] as const;

export type EmbeddedGameKey = (typeof EMBEDDED_GAME_KEYS)[number];

export function isPlatformGameKey(value: unknown): value is EmbeddedGameKey {
  return (
    typeof value === "string" &&
    (EMBEDDED_GAME_KEYS as readonly string[]).includes(value)
  );
}

export type PlatformConfig = {
  platform: string;
  origin: string;
  secret: string;
};

const PLATFORM_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export function normalizePlatformOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  // Only an explicit https origin: never a path, query, fragment, credential
  // or wildcard host (`*.example.com` is not an origin).
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.hostname.includes("*")) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash) return null;
  return `${url.protocol}//${url.host}`.toLowerCase();
}

/**
 * Parse `GRYND_PLATFORM_ALLOWLIST`. Invalid or duplicate entries are dropped;
 * the first valid origin for a slug wins.
 */
export function parsePlatformAllowlist(
  raw: unknown,
): Array<{ platform: string; origin: string }> {
  if (typeof raw !== "string" || !raw.trim()) return [];

  const seen = new Set<string>();
  const entries: Array<{ platform: string; origin: string }> = [];

  for (const part of raw.split(",")) {
    const [rawSlug, ...rest] = part.split("=");
    const slug = rawSlug.trim().toLowerCase();
    if (!PLATFORM_SLUG_PATTERN.test(slug) || seen.has(slug)) continue;

    // Origins contain no `=`, but rejoin defensively so a stray separator
    // cannot silently change the configured origin.
    const origin = normalizePlatformOrigin(rest.join("="));
    if (!origin) continue;

    seen.add(slug);
    entries.push({ platform: slug, origin });
  }

  return entries;
}

/** The configured-in-env secret for a platform, or "" when unset. */
export function getPlatformSecret(
  platform: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!PLATFORM_SLUG_PATTERN.test(platform)) return "";
  const key = `GRYND_PLATFORM_SECRET_${platform.toUpperCase().replace(/-/g, "_")}`;
  const value = env[key];
  return typeof value === "string" ? value : "";
}

/**
 * The full server-side configuration for a platform, or null when the platform
 * is not allowlisted, has no origin, has no secret or is otherwise malformed.
 */
export function getPlatformConfig(
  platform: unknown,
  env: Record<string, string | undefined> = process.env,
): PlatformConfig | null {
  if (typeof platform !== "string" || !PLATFORM_SLUG_PATTERN.test(platform)) {
    return null;
  }
  const entry = parsePlatformAllowlist(env.GRYND_PLATFORM_ALLOWLIST).find(
    (candidate) => candidate.platform === platform,
  );
  if (!entry) return null;

  const secret = getPlatformSecret(platform, env);
  if (secret.length < 16) return null;

  return { platform: entry.platform, origin: entry.origin, secret };
}

/** Every allowlisted origin, for the /embed/* `frame-ancestors` policy. */
export function getPlatformOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return parsePlatformAllowlist(env.GRYND_PLATFORM_ALLOWLIST).map((entry) => entry.origin);
}
