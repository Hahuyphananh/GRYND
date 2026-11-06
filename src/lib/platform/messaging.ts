// src/lib/platform/messaging.ts
//
// PURE postMessage contract between the embedded GRYND game and the platform
// page (Phase 5). Shared by the embed client and the tests.
//
// ── RULES ────────────────────────────────────────────────────────────────
//
//   · Every inbound message must come from the EXACT platform origin recorded on
//     the session. No substring/`endsWith` matching, no fallback to `"*"`.
//   · The envelope must be `{ source: "grynd-platform", version: 1, type }` and
//     the type must be in the closed inbound list.
//   · Unknown versions/types are ignored silently — a malformed event must never
//     throw inside the game.
//   · Outbound messages always name the platform origin explicitly. This module
//     has no wildcard target and no function that could produce one.
//
// The platform-side SDK (public/platform-sdk/grynd-platform-v1.js) implements
// the mirror image of these checks.

export const PLATFORM_MESSAGE_SOURCE = "grynd-platform";
export const PLATFORM_MESSAGE_VERSION = 1;

/** Messages the EMBED may send to the platform page. */
export const OUTBOUND_EVENTS = [
  "grynd:ready",
  "grynd:match_started",
  "grynd:match_finished",
  "grynd:session_expired",
  "grynd:exit",
  "grynd:error",
] as const;

/** Messages the EMBED accepts from the platform page. */
export const INBOUND_EVENTS = ["grynd:start", "grynd:ping"] as const;

export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number];
export type InboundEvent = (typeof INBOUND_EVENTS)[number];

export type PlatformEnvelope = {
  source: typeof PLATFORM_MESSAGE_SOURCE;
  version: typeof PLATFORM_MESSAGE_VERSION;
  type: string;
};

export function isOutboundEvent(value: unknown): value is OutboundEvent {
  return typeof value === "string" && (OUTBOUND_EVENTS as readonly string[]).includes(value);
}

export function isInboundEvent(value: unknown): value is InboundEvent {
  return typeof value === "string" && (INBOUND_EVENTS as readonly string[]).includes(value);
}

/** Build the envelope this module's caller posts to the platform. */
export function buildPlatformMessage(
  type: OutboundEvent,
  payload: Record<string, unknown> = {},
): PlatformEnvelope & Record<string, unknown> {
  return {
    source: PLATFORM_MESSAGE_SOURCE,
    version: PLATFORM_MESSAGE_VERSION,
    type,
    ...payload,
  };
}

/**
 * Validate one inbound `message` event. Returns the event type only when the
 * origin matches exactly AND the envelope is well formed; otherwise null.
 */
export function parsePlatformMessage(
  event: { origin?: unknown; data?: unknown } | null | undefined,
  allowedOrigin: string,
): { type: InboundEvent; data: Record<string, unknown> } | null {
  if (!event || typeof allowedOrigin !== "string" || !allowedOrigin) return null;
  if (typeof event.origin !== "string" || event.origin !== allowedOrigin) return null;

  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const envelope = data as Record<string, unknown>;

  if (envelope.source !== PLATFORM_MESSAGE_SOURCE) return null;
  if (envelope.version !== PLATFORM_MESSAGE_VERSION) return null;
  if (!isInboundEvent(envelope.type)) return null;

  return { type: envelope.type, data: envelope };
}

/**
 * The `targetOrigin` every embed→platform post must use. Kept as a function so
 * call sites cannot pass a literal `"*"`; an empty/invalid origin returns null
 * and the caller must not post at all.
 */
export function platformTargetOrigin(allowedOrigin: unknown): string | null {
  if (typeof allowedOrigin !== "string") return null;
  try {
    const url = new URL(allowedOrigin);
    if (url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}
