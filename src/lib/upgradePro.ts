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
import {
  PRO_BILLING_OPTIONS,
  isProBillingInterval,
  type ProBillingInterval,
} from "./proBilling";
import {
  DEFAULT_PRO_TRIAL_REMINDER_DAYS,
  isProTrialReminderDays,
  type ProTrialReminderDays,
} from "./proTrial";
import type { ProPlanDisplay } from "./membershipDisplay";
import {
  NATIVE_PURCHASE_UNAVAILABLE_MESSAGE,
  isNativeShellClient,
} from "./native/shell";

export type MembershipStatusResponse = {
  loaded: boolean;
  signedIn: boolean;
  active: boolean;
  tier: "free" | "pro";
  plan: ProPlanDisplay | null;
  status: string | null;
  /** Which billing option the member is on, when the server knows it. */
  billingInterval: ProBillingInterval | null;
  currentPeriodEnd: string | null;
  /**
   * Can this account still take the free trial? `null` while unknown (before
   * the server answers). Only the server decides it: the free week is granted
   * once per customer, so a returning canceled member gets `false` and the
   * paywall shows the plain subscription CTA.
   */
  trialEligible: boolean | null;
  refresh: () => Promise<void>;
};

type RawStatus = {
  success?: boolean;
  signedIn?: boolean;
  active?: boolean;
  tier?: string;
  plan?: ProPlanDisplay;
  status?: string;
  billingInterval?: string;
  currentPeriodEnd?: string | null;
  trialEligible?: boolean;
};

function isProPlanDisplay(value: unknown): value is ProPlanDisplay {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ProPlanDisplay).key === "string" &&
    // `priceDisplay` is what the server sends now (an amount plus the currency
    // symbol it is in). `priceUsd` is accepted so a response cached by a tab
    // running the previous build is still recognised as a plan rather than
    // discarded — normalizePlanDisplay below will not render its prices.
    (typeof (value as ProPlanDisplay).priceDisplay === "string" ||
      typeof (value as unknown as { priceUsd?: unknown }).priceUsd === "string") &&
    Array.isArray((value as ProPlanDisplay).perks)
  );
}

/**
 * Normalise a server plan for rendering. An older cached response (or a
 * partially-degraded one) may not carry `billingOptions`; the catalog defaults
 * are used so the selector always has three options to show.
 *
 * The same fallback covers a response from the build BEFORE multi-currency:
 * its options carry a bare USD amount (`priceUsd`) and no currency, and
 * rendering those would mean writing a currency symbol we cannot vouch for.
 * The catalog defaults are the base-currency amounts, which is what Stripe
 * charges when no localized price is configured — honest, and this can only
 * happen for the ~30s a tab holds a pre-deploy snapshot.
 */
function normalizePlanDisplay(plan: ProPlanDisplay): ProPlanDisplay {
  const options = plan.billingOptions;
  const renderable =
    Array.isArray(options) &&
    options.length > 0 &&
    options.every(
      (option) =>
        typeof option?.priceDisplay === "string" &&
        typeof option?.currency === "string",
    );

  return renderable ? plan : { ...plan, billingOptions: PRO_BILLING_OPTIONS };
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
  billingInterval: ProBillingInterval | null;
  currentPeriodEnd: string | null;
  trialEligible: boolean | null;
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
          ? normalizePlanDisplay(data.plan)
          : membershipSnapshot?.plan ?? null,
        status: typeof data?.status === "string" ? data.status : null,
        billingInterval: isProBillingInterval(data?.billingInterval)
          ? data.billingInterval
          : null,
        currentPeriodEnd: data?.currentPeriodEnd ?? null,
        trialEligible:
          typeof data?.trialEligible === "boolean"
            ? data.trialEligible
            : membershipSnapshot?.trialEligible ?? null,
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
              billingInterval: null,
              currentPeriodEnd: null,
              trialEligible: null,
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
  billingInterval: null,
  currentPeriodEnd: null,
  trialEligible: null,
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
    billingInterval: state.billingInterval,
    currentPeriodEnd: state.currentPeriodEnd,
    trialEligible: state.trialEligible,
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
export async function startProCheckout(
  planKey: string,
  interval: ProBillingInterval = "monthly",
  reminderDays: ProTrialReminderDays = DEFAULT_PRO_TRIAL_REMINDER_DAYS,
): Promise<ProActionResult> {
  // NATIVE APP: no in-app Stripe checkout (Play requires Play Billing for
  // digital goods). Checked here so the offer never even reaches the network —
  // and checked again in the server route, which is the boundary that actually
  // counts. Deliberately inside this async action rather than in a component's
  // render: `isNativeShellClient()` is false during SSR, so a render-time check
  // would be a hydration mismatch.
  if (isNativeShellClient()) {
    return { ok: false, error: NATIVE_PURCHASE_UNAVAILABLE_MESSAGE };
  }

  try {
    const res = await fetch("/api/stripe/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      // The client sends a plan key + a BILLING INTERVAL only. The server
      // resolves the approved Stripe Price — an amount or a price id from the
      // browser is never trusted.
      body: JSON.stringify({ planKey, interval, reminderDays }),
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
 * Switch an EXISTING subscription to a different billing interval. The server
 * moves the caller's own subscription item with explicit proration — it never
 * creates a second subscription. Resolves with the new interval on success.
 */
export async function changeProBillingInterval(
  interval: ProBillingInterval,
): Promise<ProActionResult> {
  try {
    const res = await fetch("/api/stripe/change-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ interval }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      return { ok: false, needsSignIn: true, error: "Sign in to change your membership." };
    }
    if (!res.ok || !data?.success) {
      return {
        ok: false,
        error: data?.error || "Could not change your billing interval. Please try again.",
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not change your billing interval. Please try again." };
  }
}

/** The caller's live trial reminder, read from their Stripe subscription. */
export type ProTrialReminderStatus = {
  trialing: boolean;
  /** ISO instant of the first charge (Stripe's authoritative trial end). */
  trialEndsAt: string | null;
  reminderDays: ProTrialReminderDays | null;
};

const NO_TRIAL: ProTrialReminderStatus = {
  trialing: false,
  trialEndsAt: null,
  reminderDays: null,
};

/** Read the current reminder a trialing member picked (GET, own subscription). */
export async function fetchProTrialReminder(): Promise<ProTrialReminderStatus> {
  try {
    const res = await fetch("/api/stripe/trial-reminder", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) return NO_TRIAL;
    const data = await res.json().catch(() => ({}));
    return {
      trialing: Boolean(data?.trialing),
      trialEndsAt: typeof data?.trialEndsAt === "string" ? data.trialEndsAt : null,
      reminderDays: isProTrialReminderDays(data?.reminderDays)
        ? data.reminderDays
        : null,
    };
  } catch {
    return NO_TRIAL;
  }
}

/**
 * Change or cancel the trial reminder after checkout. The server only touches
 * the caller's OWN trialing subscription; `0` means "no reminder".
 */
export async function updateProTrialReminder(
  reminderDays: ProTrialReminderDays,
): Promise<ProActionResult> {
  try {
    const res = await fetch("/api/stripe/trial-reminder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ reminderDays }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      return { ok: false, needsSignIn: true, error: "Sign in to change your reminder." };
    }
    if (!res.ok || !data?.success) {
      return {
        ok: false,
        error: data?.error || "Could not update your reminder. Please try again.",
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not update your reminder. Please try again." };
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
