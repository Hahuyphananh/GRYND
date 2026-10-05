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

import { useCallback, useEffect, useState } from "react";
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

// ── Shared, deduplicated membership store ────────────────────────────────
//
// Several surfaces on the SAME page ask for membership: the home page mounts
// both <UpgradeProButton> and <GryndProWidget>, and the upgrade page mounts
// the button again. Before this store each `useMembershipStatus()` instance
// fired its OWN GET /api/membership/status on mount, so one page load cost two
// or three identical function invocations. The store keeps ONE snapshot per
// browser tab, shares a single in-flight request between every caller, and
// notifies all subscribers when it changes. It is purely a client-side cache of
// a server response — it never decides entitlement, and it fails closed.

type MembershipSnapshot = {
  loaded: boolean;
  signedIn: boolean;
  active: boolean;
  plan: ProPlanDisplay | null;
  status: string | null;
  currentPeriodEnd: string | null;
  fetchedAt: number;
};

/** How long a fetched snapshot is reused before another mount refetches. */
const MEMBERSHIP_TTL_MS = 30_000;

let membershipSnapshot: MembershipSnapshot | null = null;
let membershipInflight: Promise<void> | null = null;
const membershipSubscribers = new Set<(s: MembershipSnapshot) => void>();

function publishMembership(next: MembershipSnapshot): void {
  membershipSnapshot = next;
  for (const notify of membershipSubscribers) notify(next);
}

async function loadMembership(force: boolean): Promise<void> {
  if (
    !force &&
    membershipSnapshot &&
    Date.now() - membershipSnapshot.fetchedAt < MEMBERSHIP_TTL_MS
  ) {
    return;
  }
  // Every caller in the tab shares one request instead of racing their own.
  if (membershipInflight) return membershipInflight;

  membershipInflight = (async () => {
    try {
      const res = await fetch("/api/membership/status", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const data: RawStatus = await res.json().catch(() => ({}));
      publishMembership({
        loaded: true,
        signedIn: Boolean(data?.signedIn),
        // Only ever adopted from the response body, and only for a Pro tier —
        // the client can never claim PRO it does not have.
        active: Boolean(data?.active) && data?.tier === "pro",
        plan: isProPlanDisplay(data?.plan)
          ? data.plan
          : membershipSnapshot?.plan ?? null,
        status: typeof data?.status === "string" ? data.status : null,
        currentPeriodEnd: data?.currentPeriodEnd ?? null,
        fetchedAt: Date.now(),
      });
    } catch {
      // Fail closed: keep the last known state (or a neutral signed-out one),
      // and mark it loaded so the upgrade surfaces settle on their fallback.
      publishMembership(
        membershipSnapshot
          ? { ...membershipSnapshot, loaded: true, fetchedAt: Date.now() }
          : {
              loaded: true,
              signedIn: false,
              active: false,
              plan: null,
              status: null,
              currentPeriodEnd: null,
              fetchedAt: Date.now(),
            },
      );
    } finally {
      membershipInflight = null;
    }
  })();

  return membershipInflight;
}

const EMPTY_MEMBERSHIP: MembershipSnapshot = {
  loaded: false,
  signedIn: false,
  active: false,
  plan: null,
  status: null,
  currentPeriodEnd: null,
  fetchedAt: 0,
};

/**
 * The caller's server-authoritative membership state.
 *
 * `active` is only ever set from the API response body — a network failure
 * leaves the user on `free`, which fails closed (a paying member briefly sees
 * the upgrade CTA; nobody sees PRO they don't have).
 *
 * The snapshot is shared across every component in the tab, so the several
 * upgrade surfaces on one page cost ONE request, not one each.
 */
export function useMembershipStatus(): MembershipStatusResponse {
  const [state, setState] = useState<MembershipSnapshot>(
    () => membershipSnapshot ?? EMPTY_MEMBERSHIP,
  );

  useEffect(() => {
    let active = true;
    const notify = (next: MembershipSnapshot) => {
      if (active) setState(next);
    };
    membershipSubscribers.add(notify);
    // Adopt whatever the shared store already has, then fetch if it is stale.
    if (membershipSnapshot) setState(membershipSnapshot);
    void loadMembership(false);
    return () => {
      active = false;
      membershipSubscribers.delete(notify);
    };
  }, []);

  const refresh = useCallback(async () => {
    await loadMembership(true);
  }, []);

  return {
    loaded: state.loaded,
    signedIn: state.signedIn,
    active: state.active,
    tier: state.active ? "pro" : "free",
    plan: state.plan,
    status: state.status,
    currentPeriodEnd: state.currentPeriodEnd,
    refresh,
  };
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
