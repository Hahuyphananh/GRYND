// src/lib/ads/core/chain.ts
//
// THE SEQUENTIAL FALLBACK ENGINE.
//
// One ad opportunity, one provider at a time:
//
//   highest-priority eligible provider → request → filled? stop.
//                                             otherwise → next provider.
//
// The rules it enforces structurally:
//
//   * NEVER PARALLEL. `attempt` is awaited before the next provider starts.
//   * NEVER TWO CREATIVES. A `filled` result ends the chain; there is no
//     post-fill fallback path.
//   * BOUNDED. Each attempt gets the smaller of its own deadline and the
//     chain's remaining budget, and an aborted chain stops immediately.
//   * NEVER AFTER A SERVE. A served opportunity returns without attempting.
//   * NEVER A CLAIMED IMPRESSION. The chain copies `verifiedImpression` from the
//     provider result; it does not set it.
//
// The engine has no React, DOM, fetch or PostHog dependency, so the same code
// drives banners and video and can be tested exhaustively.

import type { AdOutcome, AdOpportunity, AdProviderId } from "./types";
import { markOpportunityServed, wasOpportunityServed } from "./opportunity";

export interface ChainOptions {
  opportunity: AdOpportunity;
  /** Already filtered to enabled/configured/eligible providers, in priority. */
  order: readonly AdProviderId[];
  /**
   * Requests ONE provider. Must resolve to an outcome and must not throw; a
   * thrown error is converted to `network_error` by the engine anyway.
   */
  attempt: (provider: AdProviderId, budgetMs: number) => Promise<AdOutcome>;
  /** Total budget for the whole chain. `Infinity` disables the budget. */
  totalBudgetMs?: number;
  /** Aborted on unmount, navigation or a dismissed result screen. */
  signal?: AbortSignal;
  /** Observe every provider attempt, in order (reporting lives here). */
  onOutcome?: (outcome: AdOutcome, index: number) => void;
  now?: () => number;
}

export interface ChainResult {
  /** The filled outcome, or the last outcome when nothing filled. */
  outcome: AdOutcome | null;
  /** Providers actually attempted, in order. */
  attempted: AdProviderId[];
  /** True when a creative was found; no further provider was tried. */
  filled: boolean;
  /** True when the chain stopped because the opportunity had already served. */
  alreadyServed: boolean;
}

const ABORTED: AdOutcome = {
  provider: "hilltop",
  status: "blocked",
  verifiedImpression: false,
  reason: "aborted",
};

/**
 * Runs the chain. Never throws.
 *
 * `attempt` receives the per-attempt budget (remaining chain time), so a
 * provider cannot outlive the total budget even if its own deadline is longer.
 */
export async function runAdChain(options: ChainOptions): Promise<ChainResult> {
  const {
    opportunity,
    order,
    attempt,
    totalBudgetMs = Number.POSITIVE_INFINITY,
    signal,
    onOutcome,
    now = Date.now,
  } = options;

  if (wasOpportunityServed(opportunity.id)) {
    return { outcome: null, attempted: [], filled: false, alreadyServed: true };
  }

  const startedAt = now();
  const attempted: AdProviderId[] = [];
  let last: AdOutcome | null = null;

  for (let index = 0; index < order.length; index += 1) {
    if (signal?.aborted) {
      return {
        outcome: last ?? { ...ABORTED, provider: order[index] },
        attempted,
        filled: false,
        alreadyServed: false,
      };
    }

    const elapsed = now() - startedAt;
    const remaining = totalBudgetMs - elapsed;

    // Budget exhausted: no provider gets a zero-length attempt. Below 250 ms
    // an attempt could not even install its observer, so it is not started.
    if (remaining < 250) break;

    const provider = order[index];
    attempted.push(provider);

    let outcome: AdOutcome;
    try {
      outcome = await attempt(provider, remaining);
    } catch {
      outcome = {
        provider,
        status: "network_error",
        verifiedImpression: false,
        reason: "attempt-threw",
      };
    }

    last = outcome;
    onOutcome?.(outcome, index);

    if (outcome.status === "filled") {
      markOpportunityServed(opportunity.id);
      return {
        outcome,
        attempted,
        filled: true,
        alreadyServed: false,
      };
    }

    if (signal?.aborted) break;
  }

  return {
    outcome: last,
    attempted,
    filled: false,
    alreadyServed: false,
  };
}
