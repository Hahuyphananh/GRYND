// src/lib/mascot/glitchCadence.js
//
// THE RULES THAT DECIDE WHETHER GLITCH MAY SPEAK — pure, framework-free and
// testable without rendering anything. The provider (GlitchProvider.tsx) owns
// React state, timers and DOM probes; this module owns every judgement, so the
// timing rules cannot drift into a component and can be asserted directly.
//
// The same shape as src/lib/onboardingFlow.js: decisions in, decisions out, no
// storage and no network. `now` is always passed in, so every cooldown is
// testable by moving the clock rather than by waiting.
//
// ── THE MODEL ─────────────────────────────────────────────────────────────
//
// Two kinds of appearance:
//
//   INLINE   — GLITCH is part of the page (a tutorial step, a result panel).
//              Page content, like any other text. It is not rate-limited: a
//              player re-reading step 3 must still see step 3's mascot.
//   FLOATING — GLITCH appears over the page in a corner. This is the behaviour
//              that can become noise, so every limit below applies to it.
//
// That split is why the tutorial can be "priority 3" without needing a special
// exemption from the session cap: tutorial messages are inline.
//
// ── PRIORITIES ────────────────────────────────────────────────────────────
//
//   0  ambient        off unless explicitly allowed
//   1  hint           5 min cooldown
//   2  milestone      2 min cooldown
//   3  critical       bypasses the cooldowns and the minimum interval, but is
//                     STILL capped per session and still deduplicated — "may
//                     bypass ordinary cooldowns" is not "unlimited".
//
// On top of the per-priority cooldown there is one global floor: at least 90 s
// between any two floating appearances, and at most 3 per session.
//
// ── SESSION ───────────────────────────────────────────────────────────────
// In-memory only. A refreshed page is a new session, which is deliberate: the
// alternative is a persisted "GLITCH has nagged you N times" counter, and the
// right failure mode for a mascot is to be quiet after a reload, not to hold a
// grudge.

/** Priority levels, named for call sites. */
export const GLITCH_PRIORITY = Object.freeze({
  AMBIENT: 0,
  HINT: 1,
  MILESTONE: 2,
  CRITICAL: 3,
});

/** The four placements (mirrors GlitchSay). Anything but `inline` floats. */
export const GLITCH_PLACEMENTS = Object.freeze([
  "inline",
  "bottom-left",
  "bottom-right",
  "top-left",
]);

export const GLITCH_DEFAULT_PLACEMENT = "bottom-left";

/** A floating message that says nothing about how long it should stay gets 10 s. */
export const GLITCH_DEFAULT_FLOATING_AUTO_HIDE_MS = 10_000;

/**
 * The library's own mirror of the six expressions.
 *
 * It is duplicated from src/lib/mascot/glitchAssets.ts ON PURPOSE: this module
 * stays import-free so it can be unit-tested without a bundler, and
 * tests/glitch-mascot.test.mjs pins the two lists together so they cannot
 * drift (the same pattern the emote catalog uses for its migration seed).
 */
export const GLITCH_EXPRESSIONS = Object.freeze([
  "idle",
  "wink",
  "victory",
  "defeat",
  "surprised",
  "focused",
]);

export const GLITCH_DEFAULT_CONFIG = Object.freeze({
  /** At least this long between any two floating appearances. */
  minIntervalMs: 90_000,
  /** At most this many floating appearances per session. */
  maxPerSession: 3,
  /** Per-priority cooldown, measured from that priority's last appearance. */
  cooldownMs: Object.freeze({
    0: Number.POSITIVE_INFINITY,
    1: 300_000,
    2: 120_000,
    3: 0,
  }),
  /** Priority 0 exists, but is off unless a caller opts in. */
  allowAmbient: false,
});

/** The one browser event name non-React code may use. */
export const GLITCH_EVENT_NAME = "grynd:glitch";

/** A fresh, empty session. `now` is recorded for completeness/debugging. */
export function createGlitchSession(now = 0) {
  return {
    startedAt: now,
    shown: [],
    shownEventIds: [],
    lastFloatingAt: null,
    lastFloatingAtByPriority: {},
  };
}

/** True for one of the four placements. */
export function isGlitchPlacement(value) {
  return typeof value === "string" && GLITCH_PLACEMENTS.includes(value);
}

/** True for one of the six expressions. */
export function isGlitchExpression(value) {
  return typeof value === "string" && GLITCH_EXPRESSIONS.includes(value);
}

/** True for a whole priority level 0–3. */
export function isGlitchPriority(value) {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

/**
 * Is this path an ACTIVE MATCH (or practice board)?
 *
 * Derived from the real route tree rather than a hand-written list of game
 * names. Every `/casino/<game>/<segment>` route in this app is a board:
 * `[matchId]`, `[gameId]` (under `/game/`), `play-ai`, `ai` and `test` are all
 * live play. Exactly one sub-page is not — `/casino/hex-duel/history`, a
 * results list — and it is named here instead of being guessed at.
 *
 * `/casino/<game>` (the lobby) and `/casino` are deliberately allowed.
 */
export function isActiveMatchRoute(pathname) {
  if (typeof pathname !== "string" || pathname === "") return false;
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "casino") return false;
  if (segments.length < 3) return false;
  return segments[2] !== "history";
}

/**
 * Why GLITCH must not float right now, or null when it may.
 *
 * Pure: the provider passes what it observed (route + a few DOM probes that
 * already exist in this app), this decides. Every input is named for the real
 * signal behind it, so the mapping is auditable:
 *
 *   creatorMode     `[data-creator-layout]` — the recording frame
 *   match           the route itself (see isActiveMatchRoute)
 *   modal           `[aria-modal="true"]` — result screens, the post-match ad,
 *                   every sheet and dialog in the app, PracticePause, consent
 *   adNearCorner    a live `[data-ad-placement]` / `ins.adsbygoogle` in the
 *                   lower part of the viewport, where GLITCH would sit
 *   alertVisible    `[role="alert"]` — an error or retry notice is being shown
 *   busy            `[aria-busy="true"]` — a loading skeleton owns the surface
 */
export function glitchSuppressionReason(context = {}) {
  if (context.creatorMode) return "creator-mode";
  if (isActiveMatchRoute(context.pathname)) return "match";
  if (context.blockingOverlay) return "modal";
  if (context.adNearCorner) return "ad";
  if (context.alertVisible) return "alert";
  if (context.busy) return "busy";
  return null;
}

/** Normalise a caller's request, or explain why it is unusable. */
export function normalizeGlitchRequest(request) {
  if (!request || typeof request !== "object") {
    return { ok: false, reason: "invalid-request" };
  }

  const { message, expression, placement, priority, eventId, autoHideMs, dismissible, size } =
    request;

  if (message === undefined || message === null || message === "") {
    return { ok: false, reason: "empty-message" };
  }
  if (expression !== undefined && !isGlitchExpression(expression)) {
    return { ok: false, reason: "invalid-expression" };
  }
  if (placement !== undefined && !isGlitchPlacement(placement)) {
    return { ok: false, reason: "invalid-placement" };
  }
  if (priority !== undefined && !isGlitchPriority(priority)) {
    return { ok: false, reason: "invalid-priority" };
  }
  if (eventId !== undefined && (typeof eventId !== "string" || eventId.length > 120)) {
    return { ok: false, reason: "invalid-event-id" };
  }
  if (
    autoHideMs !== undefined &&
    autoHideMs !== null &&
    (typeof autoHideMs !== "number" || !Number.isFinite(autoHideMs) || autoHideMs < 0)
  ) {
    return { ok: false, reason: "invalid-auto-hide" };
  }

  return {
    ok: true,
    value: {
      message,
      expression: expression ?? "idle",
      placement: placement ?? GLITCH_DEFAULT_PLACEMENT,
      priority: priority ?? GLITCH_PRIORITY.HINT,
      eventId: eventId ?? null,
      autoHideMs: autoHideMs ?? undefined,
      dismissible: dismissible === true,
      size,
    },
  };
}

/**
 * The single decision the provider asks for.
 *
 * `request`  — what a call site asked for (see normalizeGlitchRequest)
 * `current`  — the message on screen right now, or null
 * `session`  — createGlitchSession() state
 * `now`      — Date.now()
 * `context`  — what the provider observed (see glitchSuppressionReason)
 * `config`   — overrides for GLITCH_DEFAULT_CONFIG
 *
 * Returns `{ action, reason }`:
 *   action "show"    — nothing is on screen; display it
 *   action "replace" — a lower-priority message is on screen; swap it
 *   action "ignore"  — do nothing, for `reason`
 *
 * Order matters and is deliberate: a suppressed moment is never *recorded*, so
 * a request that arrives during a match does not burn a cooldown or a session
 * slot for a real one later.
 */
export function resolveGlitchRequest({
  // `= null` rather than a bare property: TypeScript drops an undefaulted
  // destructured key from the inferred parameter type, and callers must be
  // able to pass `request` (a null request is an invalid one — see below).
  request = null,
  current = null,
  session = createGlitchSession(),
  now = 0,
  context = {},
  config = {},
} = {}) {
  const normalized = normalizeGlitchRequest(request);
  if (!normalized.ok) return { action: "ignore", reason: normalized.reason };

  const { priority, placement, eventId } = normalized.value;
  const settings = {
    ...GLITCH_DEFAULT_CONFIG,
    ...config,
    cooldownMs: { ...GLITCH_DEFAULT_CONFIG.cooldownMs, ...(config.cooldownMs ?? {}) },
  };

  if (priority === GLITCH_PRIORITY.AMBIENT && !settings.allowAmbient) {
    return { action: "ignore", reason: "ambient-disabled" };
  }

  const floating = placement !== "inline";

  // ── Inline: page content ───────────────────────────────────────────────
  // No cooldown, no session cap. Only overlap is considered, and an inline
  // message never displaces a floating one that outranks it.
  if (!floating) {
    if (current && current.priority > priority) {
      return { action: "ignore", reason: "busy" };
    }
    return { action: current ? "replace" : "show", reason: "inline" };
  }

  // ── Floating: every guard applies ──────────────────────────────────────
  const suppression = glitchSuppressionReason(context);
  if (suppression) return { action: "ignore", reason: `suppressed:${suppression}` };

  if (eventId && session.shownEventIds.includes(eventId)) {
    return { action: "ignore", reason: "duplicate-event" };
  }

  if (session.shown.length >= settings.maxPerSession) {
    // Priority 3 bypasses cooldowns, NOT the session cap: "at most 3 floating
    // appearances" is the promise, and a tutorial does not need to float.
    return { action: "ignore", reason: "session-limit" };
  }

  if (priority < GLITCH_PRIORITY.CRITICAL) {
    if (
      session.lastFloatingAt !== null &&
      now - session.lastFloatingAt < settings.minIntervalMs
    ) {
      return { action: "ignore", reason: "min-interval" };
    }
    const lastForPriority = session.lastFloatingAtByPriority[priority] ?? null;
    const cooldown = settings.cooldownMs[priority] ?? 0;
    if (lastForPriority !== null && now - lastForPriority < cooldown) {
      return { action: "ignore", reason: "cooldown" };
    }
  }

  if (current) {
    if (priority > current.priority) return { action: "replace", reason: "higher-priority" };
    return { action: "ignore", reason: "busy" };
  }

  return { action: "show", reason: "allowed" };
}

/**
 * Record that a message actually appeared. Immutable: returns a new session.
 *
 * Inline appearances are NOT recorded — they must not consume the floating
 * budget, and a re-rendered tutorial step must not lock its own eventId.
 */
export function recordGlitchAppearance(session, request, now = 0) {
  const normalized = normalizeGlitchRequest(request);
  if (!normalized.ok) return session;

  const { priority, placement, eventId } = normalized.value;
  if (placement === "inline") return session;

  return {
    ...session,
    shown: [...session.shown, { eventId, priority, placement, at: now }],
    shownEventIds: eventId
      ? session.shownEventIds.includes(eventId)
        ? session.shownEventIds
        : [...session.shownEventIds, eventId]
      : session.shownEventIds,
    lastFloatingAt: now,
    lastFloatingAtByPriority: { ...session.lastFloatingAtByPriority, [priority]: now },
  };
}

/**
 * Validate the payload of a `grynd:glitch` window event.
 *
 * Anything dispatched on `window` is attacker-reachable (an injected script, a
 * browser extension, a third-party embed), so nothing is trusted: the detail
 * must be a plain object, the message a non-empty bounded string, and every
 * optional field one of the values this module already understands. Unknown
 * fields are dropped rather than forwarded.
 *
 * Returns the request shape `resolveGlitchRequest` accepts, or null.
 */
export function normalizeGlitchEventDetail(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;

  const { message, expression, placement, priority, eventId, autoHideMs, dismissible } = detail;

  if (typeof message !== "string") return null;
  const text = message.trim();
  if (text === "" || text.length > 200) return null;

  if (expression !== undefined && !isGlitchExpression(expression)) return null;
  if (placement !== undefined && !isGlitchPlacement(placement)) return null;
  if (priority !== undefined && !isGlitchPriority(priority)) return null;
  if (eventId !== undefined && (typeof eventId !== "string" || eventId.length > 120)) return null;
  if (
    autoHideMs !== undefined &&
    (typeof autoHideMs !== "number" || !Number.isFinite(autoHideMs) || autoHideMs < 0)
  ) {
    return null;
  }

  return {
    message: text,
    expression,
    placement,
    priority,
    eventId,
    autoHideMs,
    dismissible: dismissible === true,
  };
}

/**
 * How long a message stays on screen.
 *
 * An explicit `autoHideMs` always wins (`0` is treated as "no auto-hide" by the
 * provider). Otherwise floating messages fade on their own and inline ones
 * stay — page content that vanished mid-sentence would be a bug.
 */
export function resolveAutoHideMs(placement, autoHideMs) {
  if (autoHideMs === null) return null;
  if (typeof autoHideMs === "number") return autoHideMs;
  return placement === "inline" ? null : GLITCH_DEFAULT_FLOATING_AUTO_HIDE_MS;
}
