/**
 * GRYND Checkout branding + return URLs.
 *
 * Stripe-hosted Checkout is the payment page customers actually see, so two
 * things about it are load-bearing and worth pinning:
 *
 *   1. it carries the GRYND palette (dark navy backdrop, brand-yellow CTA,
 *      rounded corners, the GRYND PRO name and our own icon) instead of
 *      Stripe's white default, and
 *   2. it always sends the customer BACK to the GRYND PRO page on the origin
 *      they checked out from — the Checkout back button is `cancel_url`, and a
 *      wrong origin is exactly how a returning customer ends up somewhere
 *      other than /upgrade-pro.
 *
 * The branding helper degrades instead of failing, because a rejected brand
 * value must never stop a payment, so the degradation ladder is tested too.
 *
 * Run: node --import tsx --test tests/stripe-checkout-branding.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CHECKOUT_BRAND,
  createBrandedCheckoutSession,
  getCheckoutBranding,
} from "../src/lib/stripe/checkoutBranding.ts";
import { getReturnBaseUrl } from "../src/lib/stripe.ts";

// ── A fake Stripe client ───────────────────────────────────────────────────
// Only `checkout.sessions.create` is exercised. `failWith` maps a call index
// (1-based) to the error that call must throw, so a test can describe a
// degradation without juggling promises by hand.
function makeStripe({ failWith = {} } = {}) {
  const calls = [];
  return {
    calls,
    checkout: {
      sessions: {
        create: async (params) => {
          calls.push(params);
          const failure = failWith[calls.length];
          if (failure) throw failure;
          return { id: `cs_test_${calls.length}`, ...params };
        },
      },
    },
  };
}

const brandingRejection = () =>
  Object.assign(new Error("Invalid branding_settings[icon]: not a valid URL"), {
    name: "StripeInvalidRequestError",
    type: "StripeInvalidRequestError",
    param: "branding_settings[icon]",
  });

// ── The brand payload ──────────────────────────────────────────────────────

test("the Checkout page carries the GRYND palette, not Stripe's defaults", () => {
  const branding = getCheckoutBranding("https://www.grynd.dedyn.io");

  assert.equal(branding.display_name, "GRYND PRO");
  assert.equal(branding.background_color, CHECKOUT_BRAND.backgroundColor);
  assert.equal(branding.button_color, CHECKOUT_BRAND.buttonColor);
  assert.equal(branding.border_style, "rounded");
  assert.equal(branding.font_family, "inter");

  // Dark backdrop, bright button: the pair the app uses everywhere else.
  assert.match(branding.background_color, /^#[0-9a-f]{6}$/i);
  assert.match(branding.button_color, /^#[0-9a-f]{6}$/i);

  // Our own square app icon, and Stripe must fetch it itself — so it has to be
  // an absolute URL on the site origin.
  assert.deepEqual(branding.icon, {
    type: "url",
    url: "https://www.grynd.dedyn.io/icon-192.png",
  });
});

test("a trailing slash on the origin never produces a double slash in the icon URL", () => {
  const branding = getCheckoutBranding("https://www.grynd.dedyn.io/");
  assert.equal(branding.icon.url, "https://www.grynd.dedyn.io/icon-192.png");
});

test("the icon is omitted when we don't have an absolute origin to serve it from", () => {
  // A relative icon URL would be a guaranteed Stripe rejection — better to
  // brand the colours and keep the page working.
  for (const baseUrl of ["", "/", "grynd.dedyn.io"]) {
    const branding = getCheckoutBranding(baseUrl);
    assert.equal(branding.icon, undefined, `no icon expected for "${baseUrl}"`);
    assert.equal(branding.display_name, "GRYND PRO");
    assert.equal(branding.background_color, CHECKOUT_BRAND.backgroundColor);
  }
});

// ── Session creation + degradation ─────────────────────────────────────────

test("a session is created with the branding attached", async () => {
  const stripe = makeStripe();
  const session = await createBrandedCheckoutSession(
    stripe,
    { mode: "subscription", cancel_url: "https://www.grynd.dedyn.io/upgrade-pro" },
    "https://www.grynd.dedyn.io"
  );

  assert.equal(session.id, "cs_test_1");
  assert.equal(stripe.calls.length, 1);
  assert.equal(stripe.calls[0].branding_settings.display_name, "GRYND PRO");
  // The caller's own parameters are untouched.
  assert.equal(stripe.calls[0].mode, "subscription");
  assert.equal(
    stripe.calls[0].cancel_url,
    "https://www.grynd.dedyn.io/upgrade-pro"
  );
});

test("a rejected icon is retried without it rather than failing the payment", async () => {
  const stripe = makeStripe({ failWith: { 1: brandingRejection() } });
  const session = await createBrandedCheckoutSession(
    stripe,
    { mode: "subscription" },
    "https://www.grynd.dedyn.io"
  );

  assert.equal(session.id, "cs_test_2");
  assert.equal(stripe.calls.length, 2);
  assert.ok(stripe.calls[1].branding_settings, "the second attempt keeps the branding");
  assert.equal(stripe.calls[1].branding_settings.icon, undefined);
  assert.equal(stripe.calls[1].branding_settings.button_color, CHECKOUT_BRAND.buttonColor);
});

test("branding rejected twice falls back to Stripe's default page", async () => {
  const stripe = makeStripe({
    failWith: { 1: brandingRejection(), 2: brandingRejection() },
  });
  const session = await createBrandedCheckoutSession(
    stripe,
    { mode: "subscription" },
    "https://www.grynd.dedyn.io"
  );

  assert.equal(session.id, "cs_test_3");
  assert.equal(stripe.calls.length, 3);
  assert.equal(stripe.calls[2].branding_settings, undefined);
  assert.equal(stripe.calls[2].mode, "subscription");
});

test("a connection/API failure is rethrown, not swallowed", async () => {
  const stripe = makeStripe({
    failWith: {
      1: Object.assign(new Error("Stripe API is unavailable"), { name: "StripeAPIError" }),
    },
  });

  await assert.rejects(
    () =>
      createBrandedCheckoutSession(
        stripe,
        { mode: "subscription" },
        "https://www.grynd.dedyn.io"
      ),
    /unavailable/
  );
  assert.equal(stripe.calls.length, 1, "only branding-shaped failures are retried");
});

test("a genuine failure still reaches the caller after the branding fallbacks", async () => {
  // Stripe can report a rejected brand value without naming branding, so an
  // invalid request is retried plain. That must never hide the real problem:
  // whichever attempt fails hardest reports its error.
  const invalidRequest = (message, param) =>
    Object.assign(new Error(message), {
      name: "StripeInvalidRequestError",
      type: "StripeInvalidRequestError",
      param,
    });

  const stripe = makeStripe({
    failWith: {
      1: invalidRequest("Invalid branding_settings:", "branding_settings"),
      2: invalidRequest("No such price: price_nope", "line_items[0][price]"),
      3: invalidRequest("No such price: price_nope", "line_items[0][price]"),
    },
  });

  await assert.rejects(
    () =>
      createBrandedCheckoutSession(
        stripe,
        { mode: "subscription" },
        "https://www.grynd.dedyn.io"
      ),
    /No such price/
  );
  assert.equal(stripe.calls.length, 3);
  assert.equal(stripe.calls[2].branding_settings, undefined);
});

// ── The way back ───────────────────────────────────────────────────────────

test("the checkout origin wins, so the customer returns to the page they left", () => {
  const prevBase = process.env.NEXT_PUBLIC_BASE_URL;
  const prevApp = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_BASE_URL = "https://www.grynd.dedyn.io";
  delete process.env.NEXT_PUBLIC_APP_URL;

  try {
    const sameSite = (host) => ({
      headers: new Headers({ host, "x-forwarded-proto": "https" }),
    });

    // www vs apex is the same site; the origin the request really used wins.
    assert.equal(
      getReturnBaseUrl(sameSite("grynd.dedyn.io")),
      "https://grynd.dedyn.io"
    );
    // A preview/staging host is a different site, so the configured origin
    // stays authoritative (and a spoofed Host can't redirect our customers).
    assert.equal(
      getReturnBaseUrl(sameSite("evil.example.com")),
      "https://www.grynd.dedyn.io"
    );
    // No usable host headers → configured origin.
    assert.equal(
      getReturnBaseUrl({ headers: new Headers() }),
      "https://www.grynd.dedyn.io"
    );
    // http origins are preserved for local development.
    assert.equal(
      getReturnBaseUrl({
        headers: new Headers({ host: "www.grynd.dedyn.io", "x-forwarded-proto": "http" }),
      }),
      "http://www.grynd.dedyn.io"
    );
  } finally {
    if (prevBase === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = prevBase;
    if (prevApp === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = prevApp;
  }
});

test("a stale configured domain never beats the domain the customer checked out on", () => {
  // The deployment moved grynd.mywire.org -> grynd.dedyn.io, but production's
  // NEXT_PUBLIC_BASE_URL lagged behind. A customer on the NEW domain must come
  // back to the new domain (and Stripe must fetch the icon from there), not be
  // stranded on the retired one where /upgrade-pro 404s.
  const prevBase = process.env.NEXT_PUBLIC_BASE_URL;
  const prevApp = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_BASE_URL = "https://www.grynd.mywire.org";
  delete process.env.NEXT_PUBLIC_APP_URL;

  try {
    const sameSite = (host) => ({
      headers: new Headers({ host, "x-forwarded-proto": "https" }),
    });

    assert.equal(
      getReturnBaseUrl(sameSite("www.grynd.dedyn.io")),
      "https://www.grynd.dedyn.io",
      "the domain the customer is on wins over the stale configured domain"
    );
    // The retired domain itself is still recognised (an old bookmark there
    // should not bounce to an unrelated host either).
    assert.equal(
      getReturnBaseUrl(sameSite("grynd.mywire.org")),
      "https://grynd.mywire.org"
    );
    // An unknown host is still rejected in favour of the configured origin.
    assert.equal(
      getReturnBaseUrl(sameSite("evil.example.com")),
      "https://www.grynd.mywire.org"
    );
  } finally {
    if (prevBase === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = prevBase;
    if (prevApp === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = prevApp;
  }
});

test("with no configured site, the request origin is still an absolute origin", () => {
  const prevBase = process.env.NEXT_PUBLIC_BASE_URL;
  const prevApp = process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;

  try {
    assert.equal(
      getReturnBaseUrl({
        headers: new Headers({ host: "localhost:3000", "x-forwarded-proto": "http" }),
      }),
      "http://localhost:3000"
    );
    // Still nothing to build an absolute URL from — the caller reports it.
    assert.equal(getReturnBaseUrl({ headers: new Headers() }), "");
  } finally {
    if (prevBase !== undefined) process.env.NEXT_PUBLIC_BASE_URL = prevBase;
    if (prevApp !== undefined) process.env.NEXT_PUBLIC_APP_URL = prevApp;
  }
});
