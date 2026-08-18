// src/lib/security/media.js
//
// Shared, dependency-free media validation for user-uploaded images.
// Used by BOTH the server (write-time enforcement in
// /api/profile/update) and the client (display-time fallback so a
// legacy/stale stored value can never be rendered as a live `src`
// attribute). Pure JS with no Node-only imports (`atob` exists in
// browsers AND Node 18+), so client components can import it safely.
//
// Security model:
//   * Only two shapes are ever accepted as a profile picture:
//       1. a base64 `data:` URL of a REAL raster image — png, jpeg,
//          webp, gif or avif — whose magic bytes are sniffed and must
//          match the declared MIME. This rejects polyglot files
//          (e.g. a PHP/JSP payload disguised as an image), SVG (which
//          can carry <script>), HTML, and every other data MIME;
//       2. an `https://` URL (e.g. Clerk-hosted avatars synced by
//          /api/sync-user). Non-https schemes — `javascript:`,
//          `file:`, `vbscript:`, `data:text/html`, `data:image/svg+xml`,
//          … — are rejected outright.
//   * Decoded image bytes are capped (MAX_IMAGE_BYTES) so an oversized
//     payload can't smuggle a decompression bomb or blow the row size.
//
// Blocked-extension note: because uploads here are strictly content-
// sniffed raster images (never served with attacker-controlled
// extensions or MIME types), executable scripts with .php / .jsp /
// .asp / .svg extensions can never pass validation — they fail the
// magic-byte check before they are ever stored.

export const ALLOWED_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/** Max decoded image bytes (2 MB). Base64 inflates ~4/3, so the raw
 *  string may be larger; the DECODED payload is what we cap. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Max raw profile-picture string length (kept in sync with the
 *  /api/profile/update schema). */
export const MAX_PROFILE_PICTURE_CHARS = 3_000_000;

const DATA_URL_REGEX =
  /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;

/**
 * Decode a base64 string into a Uint8Array. Returns null on malformed
 * input (never throws). Cross-platform: uses the global `atob`.
 */
function base64ToBytes(b64) {
  try {
    const bin = atob(b64.replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Sniff the real image type from decoded bytes. Returns the MIME on
 * match, or null when the bytes are not one of the allow-listed
 * raster formats (or are too short to be one).
 *
 *   png:  89 50 4E 47
 *   jpeg: FF D8 FF
 *   gif:  47 49 46 38 ("GIF8")
 *   webp: "RIFF" at 0..3 + "WEBP" at 8..11
 *   avif: "ftyp" at 4..7 + brand "avif"/"avis"/"av01" at 8..11
 */
export function sniffImageType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;

  // WEBP: RIFF....WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 &&
    bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  // AVIF / HEIF: ....ftyp<brand>....
  if (
    bytes[4] === 0x66 && bytes[5] === 0x74 &&
    bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === "avif" || brand === "avis" || brand === "av01") {
      return "image/avif";
    }
  }

  // PNG
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return "image/png";
  }

  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // GIF
  if (
    bytes[0] === 0x47 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x38
  ) {
    return "image/gif";
  }

  return null;
}

/**
 * Validate a profile-picture value (server write-time + client
 * display-time). Returns `{ ok: true, sanitized }` or
 * `{ ok: false, error }`.
 *
 * `sanitized` is:
 *   null           — the caller passed null / empty (means "clear").
 *   the https URL  — as-is.
 *   the data URL   — as-is (it already passed MIME + magic-byte + size).
 */
export function isSafeProfilePicture(value) {
  if (value === null || value === undefined) {
    return { ok: true, sanitized: null };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "profilePicture must be a string" };
  }

  const v = value.trim();
  if (v === "") return { ok: true, sanitized: null }; // cleared

  if (v.length > MAX_PROFILE_PICTURE_CHARS) {
    return { ok: false, error: "Profile picture is too large" };
  }

  // https URL — safe to render in an <img src> (never executes
  // scripts). Clerk-hosted avatars land here via /api/sync-user.
  if (v.startsWith("https://")) {
    return { ok: true, sanitized: v };
  }

  // Data URL — must be an allow-listed raster image whose bytes
  // actually match the declared MIME.
  if (v.startsWith("data:image/")) {
    const match = DATA_URL_REGEX.exec(v);
    if (!match) {
      return {
        ok: false,
        error: "Profile picture must be a base64 data:image/... URL",
      };
    }
    const mime = match[1];
    if (!ALLOWED_IMAGE_MIME.has(mime)) {
      return {
        ok: false,
        error: `Unsupported image type "${mime}" — use png, jpeg, webp, gif or avif`,
      };
    }
    const bytes = base64ToBytes(match[2]);
    if (bytes === null) {
      return { ok: false, error: "Profile picture contains invalid base64 data" };
    }
    if (bytes.length === 0) {
      return { ok: false, error: "Profile picture is empty" };
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error: `Profile picture must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
      };
    }
    const sniffed = sniffImageType(bytes);
    if (sniffed !== mime) {
      return {
        ok: false,
        error: "Profile picture content does not match its declared image type",
      };
    }
    return { ok: true, sanitized: v };
  }

  // Everything else — javascript:, file:, vbscript:, data:text/html,
  // data:image/svg+xml, http://, relative paths, etc. — is rejected.
  return {
    ok: false,
    error: "Profile picture must be a data:image/... URL or an https:// URL",
  };
}

/** Boolean convenience for display-time fallbacks (client + server). */
export function isSafeProfilePictureUrl(value) {
  return isSafeProfilePicture(value).ok === true;
}

/**
 * Sanitize a profile-picture value for storage: returns the safe
 * string (data URL / https URL) or null (cleared / rejected).
 * Callers that need to distinguish "rejected" from "cleared" should
 * use isSafeProfilePicture directly.
 */
export function sanitizeProfilePicture(value) {
  const result = isSafeProfilePicture(value);
  return result.ok ? result.sanitized : null;
}
