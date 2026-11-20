// src/lib/native/shell.ts
//
// Is this request coming from the GRYND native app (the Capacitor shell)?
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// Two things must NOT happen inside the native app, for store-policy reasons
// rather than preference:
//
//   1. ADSENSE. AdSense is licensed for web pages. Serving its tag inside an
//      app WebView is AdMob's territory, and doing it anyway risks a policy
//      strike on the AdSense account that monetises the website.
//   2. STRIPE CHECKOUT. Google Play requires Play Billing for digital goods
//      consumed in-app, so a coin pack or a PRO subscription sold through
//      Stripe inside the Android build is a rejection.
//
// So the app has to be able to say "I am the app", and the SERVER has to be
// able to hear it. That is what the `GRYNDApp/<version>` token in the WebView
// User-Agent is for (capacitor.config.ts → `appendUserAgent`).
//
// ── Why a User-Agent token and not a client-side flag ─────────────────────
//
// The ad model in this repo is deliberately server-authoritative: there is no
// `premium` prop, no localStorage flag and no request body field that changes
// what an ad surface renders (see lib/adEntitlement.ts and components/
// AdSlot.tsx). A checkout gate has to be at least that strong — the point of
// gate 2 is to survive a user who opens devtools and calls the endpoint
// directly.
//
// A UA token is not a security boundary, and it is not treated as one: it
// decides what the SERVER RENDERS and whether a purchase route will run, and
// the pairing module (lib/native/shellServer.ts) re-derives it from the request
// headers on every render. Someone spoofing the token only denies themselves
// ads and purchases — which is exactly the safe direction.
//
// ── Safety ────────────────────────────────────────────────────────────────
//
// This module has NO imports and touches no request state, so it is safe in a
// server component, a route handler and a client component alike. (The
// `next/headers` reader lives in shellServer.ts, which only server code may
// import — importing that from a client component would break the build.)

/** The token appended to the native WebView's User-Agent. */
export const NATIVE_SHELL_UA_TOKEN = "GRYNDApp";

/**
 * Matches the token with its version, e.g. `GRYNDApp/1.0`. The version is
 * required so a bare mention of the word in some other product's UA cannot
 * switch the gates on by accident.
 */
const NATIVE_SHELL_UA_PATTERN = new RegExp(`${NATIVE_SHELL_UA_TOKEN}\\/\\d`);

/**
 * What a surface says when someone tries to buy in the app. Shared by the
 * server routes and the client action so both give the same instruction.
 */
export const NATIVE_PURCHASE_UNAVAILABLE_MESSAGE =
  "Memberships and coin packs can't be purchased in the app. Open grynd.dedyn.io in a browser to buy or manage them.";

/** True when a User-Agent string was sent by the GRYND native shell. */
export function isNativeShellUserAgent(userAgent: string | null | undefined): boolean {
  if (typeof userAgent !== "string" || userAgent === "") return false;
  return NATIVE_SHELL_UA_PATTERN.test(userAgent);
}

/** Minimal header-bag shape shared by `Request`, `NextRequest` and `Headers`. */
type HeaderReader = { get(name: string): string | null };

/**
 * True when a request (a route handler's `Request`, or anything with
 * `headers.get`) came from the native shell.
 *
 * Failure policy: FALSE. An unreadable request is treated as the website, so a
 * bug here can never switch the website's own ads or checkout off.
 */
export function isNativeShellRequest(
  request: { headers?: HeaderReader } | null | undefined
): boolean {
  try {
    return isNativeShellUserAgent(request?.headers?.get("user-agent"));
  } catch {
    return false;
  }
}

/**
 * The browser-side answer, for client components.
 *
 * Two independent signals, because either can be missing: Capacitor's injected
 * runtime (authoritative — it only exists inside the shell), and the UA token
 * (which the same shell appends). False on the server, so call it from an
 * effect or an event handler, never during render — a `true` here on the
 * client but not on the server would be a hydration mismatch.
 */
export function isNativeShellClient(): boolean {
  if (typeof window === "undefined") return false;

  try {
    const capacitor = (
      window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    ).Capacitor;
    if (
      capacitor &&
      typeof capacitor.isNativePlatform === "function" &&
      capacitor.isNativePlatform() === true
    ) {
      return true;
    }
  } catch {
    // A broken/absent bridge is not a reason to break the page.
  }

  try {
    return isNativeShellUserAgent(navigator.userAgent);
  } catch {
    return false;
  }
}
