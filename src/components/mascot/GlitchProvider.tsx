"use client";

// src/components/mascot/GlitchProvider.tsx
//
// THE ONE FLOATING GLITCH. Mounted once, at the end of the root layout; every
// appearance after that is a request from a call site:
//
//   const { say } = useGlitch();
//   say({ expression: "victory", message: "Four in a row.", priority: 2,
//         eventId: "streak:4" });
//
// WHY A PROVIDER. The alternative — each screen rendering its own floating
// mascot — cannot enforce "at most three per session" or "never during a match",
// because no single component knows what the others have shown. All judgement
// lives in src/lib/mascot/glitchCadence.js (pure, unit-tested); this file only
// holds the state, the timer, the DOM probes and the portal.
//
// INLINE IS NOT THIS COMPONENT'S JOB. A tutorial step or a result panel that
// wants GLITCH next to its own copy renders <GlitchSay placement="inline" />
// directly — page content, laid out by the page. `say()` therefore refuses
// `inline` rather than dumping a portal at the end of <body>.
//
// LAYER. GlitchSay is already `fixed z-[80]` (Stage 1). That is deliberately
// UNDER the toast stack (z-[100]), the PVP result screen (z-[95]) and the
// post-match ad (z-[100]), so an interruption can never be covered by a mascot,
// and ABOVE the navbar (z-40). Bottom-LEFT is the default corner because the
// toast stack and the chat bubble own the right side, and the profile/balance
// chip owns the top right.
//
// POINTER EVENTS. GlitchSay's fixed wrapper is `pointer-events-none` and only
// the dismiss button re-enables them, so the mascot can never swallow a tap
// meant for the board beneath it.
//
// This component adds no sound, no focus movement, no dialog semantics, no
// scroll lock, and no continuous animation (GlitchSay fades once, through the
// shared `withReducedMotion` helper).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import GlitchSay, {
  type GlitchPlacement,
  type GlitchPriority,
  type GlitchSaySize,
} from "./GlitchSay";
import { isGlitchExpression, type GlitchExpression } from "../../lib/mascot/glitchAssets";
import {
  createGlitchSession,
  GLITCH_DEFAULT_PLACEMENT,
  GLITCH_EVENT_NAME,
  isGlitchPlacement,
  isGlitchPriority,
  normalizeGlitchEventDetail,
  recordGlitchAppearance,
  resolveAutoHideMs,
  resolveGlitchRequest,
} from "../../lib/mascot/glitchCadence";

export type GlitchSayRequest = {
  /** One of the six expressions. Defaults to `idle`. */
  expression?: GlitchExpression;
  /** What GLITCH says. Required — a silent floating mascot is just noise. */
  message: ReactNode;
  /** A corner. `inline` is page-owned and is refused here. */
  placement?: GlitchPlacement;
  size?: GlitchSaySize;
  /** 0 ambient (off by default) · 1 hint · 2 milestone · 3 critical. */
  priority?: GlitchPriority;
  /** Stable id for one event, so it can never be shown twice in a session. */
  eventId?: string;
  /** Override the auto-hide. `null` keeps it until dismissed. */
  autoHideMs?: number | null;
  dismissible?: boolean;
};

export type GlitchApi = {
  /** Request a floating message. Returns whether it was accepted. */
  say: (request: GlitchSayRequest) => boolean;
  /** Remove the current message immediately. Safe to call at any time. */
  hide: () => void;
  /** False outside the provider — call sites that care can stay silent. */
  isAvailable: boolean;
};

/**
 * Outside the provider nothing renders and nothing throws. A component reused
 * in a test render, a story, or a route the provider does not wrap must not
 * crash because the mascot is missing.
 */
const GLITCH_FALLBACK: GlitchApi = {
  say: () => false,
  hide: () => {},
  isAvailable: false,
};

const GlitchContext = createContext<GlitchApi>(GLITCH_FALLBACK);

export function useGlitch(): GlitchApi {
  return useContext(GlitchContext);
}

type ActiveMessage = {
  id: number;
  expression: GlitchExpression;
  message: ReactNode;
  placement: GlitchPlacement;
  size: GlitchSaySize | undefined;
  priority: GlitchPriority;
  eventId: string | null;
  dismissible: boolean;
  autoHideMs: number | null;
};

// ── The DOM probes ────────────────────────────────────────────────────────
// Every selector below is an attribute this app already puts on real markup;
// nothing is a URL substring guess. `null` means "no signal".
const BLOCKING_OVERLAY = '[aria-modal="true"]';
const BUSY_SURFACE = '[aria-busy="true"]';
const LIVE_ALERT = '[role="alert"]';
const AD_SURFACE = "[data-ad-placement], ins.adsbygoogle";
// Creator Mode does not exist in this codebase yet. The attribute is the one
// qa/board-fit-check.mjs already refers to as the recording frame, so this probe
// starts working the day the feature lands and costs one querySelector today.
const CREATOR_MODE = "[data-creator-layout]";

/** Height fraction below which an ad would sit on top of GLITCH's corner. */
const AD_CORNER_THRESHOLD = 0.55;

function adOccupiesLowerViewport(): boolean {
  const nodes = document.querySelectorAll(AD_SURFACE);
  if (nodes.length === 0) return false;
  const limit = window.innerHeight * AD_CORNER_THRESHOLD;
  for (const node of Array.from(nodes)) {
    const rect = node.getBoundingClientRect();
    // A detached or display:none slot has no box — it cannot be covered.
    if (rect.height > 0 && rect.bottom > limit) return true;
  }
  return false;
}

/** What the provider observed, in the shape the pure rules expect. */
function readSuppressionContext(pathname: string | null) {
  return {
    pathname: pathname ?? "",
    creatorMode: !!document.querySelector(CREATOR_MODE),
    blockingOverlay: !!document.querySelector(BLOCKING_OVERLAY),
    alertVisible: !!document.querySelector(LIVE_ALERT),
    busy: !!document.querySelector(BUSY_SURFACE),
    adNearCorner: adOccupiesLowerViewport(),
  };
}

/**
 * Trim a caller's request down to what the rules understand.
 *
 * The typed API already restricts the values; this is the runtime half, so a
 * JS caller, a loosened type or a browser event cannot push an unknown
 * expression or a negative timeout through. Invalid optional fields are
 * dropped (the default applies) rather than rejecting the whole message —
 * except a missing message, which has nothing to render.
 */
function sanitizeRequest(request: Partial<GlitchSayRequest> | null | undefined) {
  if (!request || typeof request !== "object") return null;
  const { message, expression, placement, priority, eventId, autoHideMs, dismissible, size } =
    request;
  if (message === undefined || message === null || message === "") return null;

  return {
    message,
    expression: isGlitchExpression(expression) ? expression : undefined,
    placement: isGlitchPlacement(placement) ? placement : undefined,
    priority: isGlitchPriority(priority) ? priority : undefined,
    eventId: typeof eventId === "string" ? eventId : undefined,
    autoHideMs:
      autoHideMs === null ? null : typeof autoHideMs === "number" ? autoHideMs : undefined,
    dismissible: dismissible === true,
    size,
  };
}

export default function GlitchProvider({ children }: { children?: ReactNode }) {
  const pathname = usePathname();
  const [current, setCurrent] = useState<ActiveMessage | null>(null);
  const [portalReady, setPortalReady] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);

  // Refs, not state: the limits are read and written inside callbacks, and a
  // re-render per recorded appearance would defeat "avoid unnecessary global
  // rerenders". Only the message actually on screen is state.
  const sessionRef = useRef(createGlitchSession());
  const currentRef = useRef<ActiveMessage | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(0);
  const pathnameRef = useRef<string | null>(pathname);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    if (!currentRef.current) return;
    currentRef.current = null;
    setCurrent(null);
  }, [clearTimer]);

  const say = useCallback(
    (request: GlitchSayRequest) => {
      const prepared = sanitizeRequest(request);
      if (!prepared) return false;

      const placement = (prepared.placement ?? GLITCH_DEFAULT_PLACEMENT) as GlitchPlacement;
      // Page-owned, not floating: a tutorial renders its own GlitchSay.
      if (placement === "inline") return false;

      const now = Date.now();
      const decision = resolveGlitchRequest({
        request: prepared,
        current: currentRef.current,
        session: sessionRef.current,
        now,
        context: readSuppressionContext(pathnameRef.current),
      });

      if (decision.action === "ignore") return false;

      clearTimer();

      const message: ActiveMessage = {
        id: idRef.current + 1,
        expression: (prepared.expression ?? "idle") as GlitchExpression,
        message: prepared.message,
        placement,
        size: prepared.size,
        priority: (prepared.priority ?? 1) as GlitchPriority,
        eventId: prepared.eventId ?? null,
        dismissible: prepared.dismissible,
        autoHideMs: resolveAutoHideMs(placement, prepared.autoHideMs) as number | null,
      };
      idRef.current = message.id;

      currentRef.current = message;
      setCurrent(message);

      // Only a floating appearance spends the session budget (the rules do the
      // same check, so this can never disagree with the decision above).
      sessionRef.current = recordGlitchAppearance(
        sessionRef.current,
        {
          message: message.message,
          expression: message.expression,
          placement: message.placement,
          priority: message.priority,
          eventId: message.eventId ?? undefined,
          dismissible: message.dismissible,
        },
        now
      );

      if (message.autoHideMs !== null && message.autoHideMs > 0) {
        timerRef.current = setTimeout(hide, message.autoHideMs);
      }

      return true;
    },
    [clearTimer, hide]
  );

  // Portal only after mount: `document` does not exist during the server
  // render, and rendering it earlier would be a hydration mismatch (the same
  // fix ToastProvider documents).
  useEffect(() => {
    setPortalReady(true);
  }, []);

  // Responsive size. A 120px mascot plus a bubble is too wide for a small
  // phone, so narrow viewports get `sm`; the bubble itself is already capped at
  // min(76vw, 20rem) inside GlitchBubble.
  useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setIsNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // A message belongs to the page that asked for it. Navigating — into a match
  // especially — must never carry it across.
  useEffect(() => {
    pathnameRef.current = pathname;
    hide();
  }, [pathname, hide]);

  // The non-React integration point. One documented event name; the payload is
  // validated by the rules module before anything is displayed, because
  // anything that can dispatch on `window` is untrusted.
  useEffect(() => {
    const onGlitchEvent = (event: Event) => {
      const detail = normalizeGlitchEventDetail((event as CustomEvent).detail);
      if (!detail) return;
      say(detail);
    };
    window.addEventListener(GLITCH_EVENT_NAME, onGlitchEvent);
    return () => window.removeEventListener(GLITCH_EVENT_NAME, onGlitchEvent);
  }, [say]);

  // Timers do not survive the provider; leaving one armed would fire `hide`
  // against an unmounted tree.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    []
  );

  // Stable for the life of the mount, so a message appearing or disappearing
  // never re-renders a consumer that only wants `say`.
  const api = useMemo<GlitchApi>(() => ({ say, hide, isAvailable: true }), [say, hide]);

  return (
    <GlitchContext.Provider value={api}>
      {children}
      {portalReady && current
        ? createPortal(
            <GlitchSay
              // A new id remounts GlitchSay, so a message arriving after one was
              // dismissed is not stuck behind the previous instance's state.
              key={current.id}
              expression={current.expression}
              message={current.message}
              placement={current.placement}
              size={isNarrow ? "sm" : current.size}
              priority={current.priority}
              eventId={current.eventId ?? undefined}
              dismissible={current.dismissible}
              // The provider owns the timer (it must also be able to clear it on
              // navigation or replacement), so GlitchSay must not run its own.
              autoHideMs={null}
              onDismiss={hide}
            />,
            document.body
          )
        : null}
    </GlitchContext.Provider>
  );
}
