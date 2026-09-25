"use client";

// src/lib/upgradePro.ts
//
// Client-side helpers for the GRYND PRO upgrade surfaces.
//
// There are exactly two membership actions and they both reuse the existing
// Stripe infrastructure — no new payment code lives here:
//
//   * startProCheckout(planKey) → POST /api/stripe/subscribe. The server
//     resolves the price from the plan catalog (the client only sends a plan
//     key) and returns a Stripe-hosted Checkout URL.
//   * openProBillingPortal() → POST /api/stripe/portal. Creates a Stripe
//     Customer Portal session for the caller's OWN subscription so they can
//     update payment details or cancel.
//
// `useMembershipStatus` is the read side: it asks the server what this user's
// membership actually is. The client NEVER decides PRO status locally — there
// is no localStorage flag, no prop and no client-side override that can make a
// free account look like a subscriber. Until the server answers, `loaded` is
// false and every upgrade surface renders a neutral placeholder.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProPlanDisplay } from "./membershipDisplay";

export type MembershipStatusResponse = {
  loaded: boolean;
  signedIn: boolean;
  active: boolean;
  tier: "free" | "pro";
  plan: ProPlanDisplay | null;
  status: string | null;
  currentPeriodEnd: string | null;
  refresh: () => Promise<void>;
};

type RawStatus = {
  success?: boolean;
  signedIn?: boolean;
  active?: boolean;
  tier?: string;
  plan?: ProPlanDisplay;
  status?: string;
  currentPeriodEnd?: string | null;
};

function isProPlanDisplay(value: unknown): value is ProPlanDisplay {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ProPlanDisplay).key === "string" &&
    typeof (value as ProPlanDisplay).priceUsd === "string" &&
    Array.isArray((value as ProPlanDisplay).perks)
  );
}

/**
 * The caller's server-authoritative membership state.
 *
 * `active` is only ever set from the API response body — a network failure
 * leaves the user on `free`, which fails closed (a paying member briefly sees
 * the upgrade CTA; nobody sees PRO they don't have).
 */
export function useMembershipStatus(): MembershipStatusResponse {
  const [loaded, setLoaded] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [active, setActive] = useState(false);
  const [plan, setPlan] = useState<ProPlanDisplay | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/membership/status", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const data: RawStatus = await res.json().catch(() => ({}));
      if (!mounted.current) return;
      if (isProPlanDisplay(data?.plan)) setPlan(data.plan);
      setSignedIn(Boolean(data?.signedIn));
      setActive(Boolean(data?.active) && data?.tier === "pro");
      setStatus(typeof data?.status === "string" ? data.status : null);
      setCurrentPeriodEnd(data?.currentPeriodEnd ?? null);
    } catch {
      // Fail closed: stay on the state we already have.
    } finally {
      if (mounted.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { loaded, signedIn, active, tier: active ? "pro" : "free", plan, status, currentPeriodEnd, refresh };
}

export type ProActionResult = {
  ok: boolean;
  /** User-facing message when ok === false. */
  error?: string;
  /** The caller is not signed in — send them through sign-up first. */
  needsSignIn?: boolean;
};

/**
 * Start the GRYND PRO subscription checkout. Redirects the browser to the
 * Stripe-hosted Checkout page on success.
 */
export async function startProCheckout(planKey: string): Promise<ProActionResult> {
  try {
    const res = await fetch("/api/stripe/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ planKey }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      return { ok: false, needsSignIn: true, error: "Sign in to subscribe." };
    }
    if (res.status === 409) {
      // Already subscribed (e.g. the webhook landed between renders).
      return { ok: false, error: "You already have an active subscription." };
    }
    if (!res.ok || !data?.url) {
      return {
        ok: false,
        error: data?.error || "Could not start the subscription. Please try again.",
      };
    }
    window.location.href = data.url;
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not start the subscription. Please try again." };
  }
}

/**
 * Open the Stripe Customer Portal for the caller's active subscription.
 * Redirects the browser to the portal on success.
 */
export async function openProBillingPortal(): Promise<ProActionResult> {
  try {
    const res = await fetch("/api/stripe/portal", {
      method: "POST",
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      return { ok: false, needsSignIn: true, error: "Sign in to manage your membership." };
    }
    if (!res.ok || !data?.url) {
      return {
        ok: false,
        error: data?.error || "Could not open subscription management.",
      };
    }
    window.location.href = data.url;
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not open subscription management." };
  }
}
