// src/lib/ads/banners/runtime.ts
//
// PROVIDER-SPECIFIC BANNER LOADERS for the unified slot.
//
// One provider is loaded at a time into the SAME container. Each loader:
//
//   * injects only its own documented tag (Hilltop snippet / ExoClick
//     `<ins>` + provider queue / Adcash library + `aclib.runBanner`),
//   * watches the container for a CREATIVE, never for a script `load`,
//   * resolves on fill, an explicit failure, a CSP refusal or the deadline,
//   * clears its own container on failure so a later provider starts clean,
//   * and never calls a popunder, push, autotag, interstitial or anti-adblock
//     API.
//
// Fill detection limitations are real and are recorded in the outcome reason:
// display networks expose no reliable "no fill" callback. ExoClick and Adcash
// draw into our element, so an empty element after the deadline is `timeout`;
// Hilltop's snippet inserts beside its own script, so no non-script child after
// the deadline is also `timeout`. Neither is ever counted as an impression.

import {
  HILLTOP_PROVIDER_HOST,
  HILLTOP_SNIPPET_ATTRIBUTE,
  hilltopBannerLoadedThisSession,
  hilltopBannerScriptUrl,
  hilltopBannerSessionStorage,
  hilltopBannerSnippet,
  markHilltopBannerLoaded,
} from "../../hilltop/config";
import {
  EXOCLICK_INS_ATTRIBUTE,
  EXOCLICK_PROVIDER_ATTRIBUTE,
  exoclickBannerScriptUrl,
  exoclickInsClass,
  exoclickZoneId,
  isExoclickProviderHost,
} from "../../exoclick/config";
import {
  ADCASH_LIBRARY_ATTRIBUTE,
  adcashLibraryUrl,
  adcashRunKey,
  adcashZoneId,
  isAdcashProviderHost,
  shouldRunAdcashZone,
} from "../../adcash/config";
import type {
  AdOutcome,
  AdOutcomeStatus,
  AdProviderId,
  BannerPlacement,
} from "../core/types";
import { bannerProviderTimeoutMs } from "./limits";

export interface BannerAttemptContext {
  placement: BannerPlacement;
  opportunityId: string;
  /** Remaining chain budget; the loader uses the smaller of this and its cap. */
  budgetMs: number;
  signal?: AbortSignal;
}

type FillResult = "filled" | "timeout" | "blocked" | "network_error";

interface FillWatcher {
  promise: Promise<FillResult>;
  fail: (reason: "network_error" | "blocked") => void;
  stop: () => void;
}

/**
 * Watches `container` until a creative appears, the deadline passes, CSP blocks
 * a provider resource, or the caller aborts.
 */
function watchForFill(options: {
  container: HTMLElement;
  isPresent: () => boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  isProviderHost: (hostname: string) => boolean;
}): FillWatcher {
  const { container, isPresent, timeoutMs, signal, isProviderHost } = options;

  let settled = false;
  let resolveFn: (result: FillResult) => void = () => {};
  let observer: MutationObserver | null = null;
  let timer = 0;
  let onViolation: ((event: SecurityPolicyViolationEvent) => void) | null = null;
  let onAbort: (() => void) | null = null;

  const stop = () => {
    observer?.disconnect();
    observer = null;
    window.clearTimeout(timer);
    if (onViolation) document.removeEventListener("securitypolicyviolation", onViolation);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  };

  const settle = (result: FillResult) => {
    if (settled) return;
    settled = true;
    stop();
    resolveFn(result);
  };

  const promise = new Promise<FillResult>((resolve) => {
    resolveFn = resolve;
  });

  if (isPresent()) {
    // Resolve on the next microtask so callers can still attach handlers.
    queueMicrotask(() => settle("filled"));
    return { promise, fail: () => {}, stop };
  }

  observer = new MutationObserver(() => {
    if (isPresent()) settle("filled");
  });
  observer.observe(container, { childList: true, subtree: true, attributes: true });

  onViolation = (event) => {
    const directive = String(event.effectiveDirective);
    if (
      directive &&
      !directive.startsWith("script-src") &&
      !directive.startsWith("frame-src") &&
      !directive.startsWith("img-src")
    ) {
      return;
    }
    try {
      if (isProviderHost(new URL(String(event.blockedURI)).hostname)) {
        settle("blocked");
      }
    } catch {
      // An opaque blockedURI is not proof about this provider.
    }
  };
  document.addEventListener("securitypolicyviolation", onViolation);

  timer = window.setTimeout(() => settle("timeout"), Math.max(250, timeoutMs));

  if (signal) {
    onAbort = () => settle("blocked");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    promise,
    fail: (reason) => settle(reason),
    stop: () => settle("blocked"),
  };
}

function attemptTimeoutMs(budgetMs: number): number {
  const configured = bannerProviderTimeoutMs();
  const budget = Number.isFinite(budgetMs) ? budgetMs : configured;
  return Math.max(250, Math.min(configured, budget));
}

function clearContainer(container: HTMLElement): void {
  container.replaceChildren();
}

function outcome(
  provider: AdProviderId,
  status: AdOutcomeStatus,
  reason: string,
): AdOutcome {
  return { provider, status, verifiedImpression: false, reason };
}

// ── HilltopAds ──────────────────────────────────────────────────────────────

function hilltopPresent(container: HTMLElement): boolean {
  return Array.from(container.children).some((child) => child.tagName !== "SCRIPT");
}

async function loadHilltop(
  container: HTMLElement,
  context: BannerAttemptContext,
): Promise<AdOutcome> {
  const url = hilltopBannerScriptUrl();
  if (!url) return outcome("hilltop", "provider_disabled", "invalid-loader");

  const storage = hilltopBannerSessionStorage();
  if (hilltopBannerLoadedThisSession(storage)) {
    // The provider tag is loaded at most once per tab. A page later in the same
    // session gets no creative from Hilltop; the chain may try the next one.
    return outcome("hilltop", "no_fill", "session-dedupe");
  }

  const watcher = watchForFill({
    container,
    isPresent: () => hilltopPresent(container),
    timeoutMs: attemptTimeoutMs(context.budgetMs),
    signal: context.signal,
    isProviderHost: (host) => host === HILLTOP_PROVIDER_HOST,
  });

  markHilltopBannerLoaded(storage);

  const snippet = document.createElement("script");
  snippet.setAttribute(HILLTOP_SNIPPET_ATTRIBUTE, "1");
  snippet.text = hilltopBannerSnippet(url);
  container.appendChild(snippet);

  const result = await watcher.promise;
  if (result === "filled") return outcome("hilltop", "filled", "creative-present");

  clearContainer(container);
  if (result === "blocked") return outcome("hilltop", "blocked", "csp-or-abort");
  if (result === "network_error") return outcome("hilltop", "network_error", "tag-error");
  return outcome("hilltop", "timeout", "no-creative-before-deadline");
}

// ── ExoClick ────────────────────────────────────────────────────────────────

function exoclickPresent(container: HTMLElement): boolean {
  const ins = container.querySelector<HTMLElement>(`ins[${EXOCLICK_INS_ATTRIBUTE}]`);
  if (!ins) return false;
  if (ins.querySelector("iframe, img, video, canvas, object, embed")) return true;

  // An empty `<ins>` has no box. Only a laid-out element counts, so a loaded
  // script is never mistaken for a served ad.
  const rect = ins.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

async function loadExoclick(
  container: HTMLElement,
  context: BannerAttemptContext,
): Promise<AdOutcome> {
  const zone = exoclickZoneId(context.placement);
  const insClass = exoclickInsClass(context.placement);
  const url = exoclickBannerScriptUrl();
  if (!zone || !insClass || !url) {
    return outcome("exoclick", "provider_disabled", "not-configured");
  }

  const watcher = watchForFill({
    container,
    isPresent: () => exoclickPresent(container),
    timeoutMs: attemptTimeoutMs(context.budgetMs),
    signal: context.signal,
    isProviderHost: isExoclickProviderHost,
  });

  const ins = document.createElement("ins");
  ins.className = insClass;
  ins.setAttribute("data-zoneid", zone);
  ins.setAttribute(EXOCLICK_INS_ATTRIBUTE, "1");
  container.appendChild(ins);

  if (!document.querySelector(`script[${EXOCLICK_PROVIDER_ATTRIBUTE}]`)) {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.type = "application/javascript";
    script.setAttribute(EXOCLICK_PROVIDER_ATTRIBUTE, "1");
    script.addEventListener("error", () => watcher.fail("network_error"), { once: true });
    document.head.appendChild(script);
  }

  try {
    const provider = window as unknown as { AdProvider?: unknown[] };
    provider.AdProvider = provider.AdProvider || [];
    provider.AdProvider.push({ serve: {} });
  } catch {
    watcher.fail("network_error");
  }

  const result = await watcher.promise;
  if (result === "filled") return outcome("exoclick", "filled", "creative-present");

  clearContainer(container);
  if (result === "blocked") return outcome("exoclick", "blocked", "csp-or-abort");
  if (result === "network_error") return outcome("exoclick", "network_error", "tag-error");
  return outcome("exoclick", "timeout", "no-creative-before-deadline");
}

// ── Adcash ──────────────────────────────────────────────────────────────────

const executedAdcashZones = new Set<string>();

function adcashPresent(container: HTMLElement): boolean {
  if (container.childElementCount === 0) return false;
  if (container.querySelector("iframe, img, video, canvas, object, embed")) return true;
  const rect = container.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

async function loadAdcash(
  container: HTMLElement,
  context: BannerAttemptContext,
): Promise<AdOutcome> {
  // The opportunity id picks which of the account's Display zones is used, so
  // two zones alternate instead of one taking every request.
  const zone = adcashZoneId(context.placement, context.opportunityId);
  const libraryUrl = adcashLibraryUrl();
  if (!zone || !libraryUrl) {
    return outcome("adcash", "provider_disabled", "not-configured");
  }

  const key = adcashRunKey(context.placement, zone);
  if (!shouldRunAdcashZone(executedAdcashZones, key)) {
    return outcome("adcash", "no_fill", "zone-dedupe");
  }

  // The container must carry the id `renderIn` names. The slot sets it; refuse
  // rather than letting the provider guess a parent.
  if (!container.id) {
    return outcome("adcash", "provider_disabled", "container-not-addressable");
  }

  const watcher = watchForFill({
    container,
    isPresent: () => adcashPresent(container),
    timeoutMs: attemptTimeoutMs(context.budgetMs),
    signal: context.signal,
    isProviderHost: isAdcashProviderHost,
  });

  const run = () => {
    if (context.signal?.aborted) return;
    if (!shouldRunAdcashZone(executedAdcashZones, key)) return;
    executedAdcashZones.add(key);

    const api = (
      window as unknown as {
        aclib?: { runBanner?: (options: Record<string, string>) => unknown };
      }
    ).aclib;

    if (!api || typeof api.runBanner !== "function") {
      watcher.fail("network_error");
      return;
    }

    try {
      const result = api.runBanner({
        zoneId: zone,
        renderIn: `#${container.id}`,
      });
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(() => watcher.fail("network_error"));
      }
    } catch {
      watcher.fail("network_error");
    }
  };

  const existing = document.querySelector<HTMLScriptElement>(
    `script[${ADCASH_LIBRARY_ATTRIBUTE}]`,
  );

  if (existing) {
    if ((window as unknown as { aclib?: unknown }).aclib) run();
    else existing.addEventListener("load", run, { once: true });
  } else {
    const script = document.createElement("script");
    script.src = libraryUrl;
    script.async = true;
    script.type = "text/javascript";
    script.setAttribute(ADCASH_LIBRARY_ATTRIBUTE, "1");
    script.addEventListener("load", run, { once: true });
    script.addEventListener("error", () => watcher.fail("network_error"), { once: true });
    document.head.appendChild(script);
  }

  const result = await watcher.promise;
  if (result === "filled") return outcome("adcash", "filled", "creative-present");

  clearContainer(container);
  if (result === "blocked") return outcome("adcash", "blocked", "csp-or-abort");
  if (result === "network_error") return outcome("adcash", "network_error", "tag-error");
  return outcome("adcash", "timeout", "no-creative-before-deadline");
}

// ── Entry point ─────────────────────────────────────────────────────────────

/** Loads one provider into the container. Never throws. */
export async function loadBannerProvider(
  provider: AdProviderId,
  container: HTMLElement,
  context: BannerAttemptContext,
): Promise<AdOutcome> {
  const startedAt = Date.now();
  clearContainer(container);

  if (context.signal?.aborted) {
    return { ...outcome(provider, "blocked", "aborted"), latencyMs: 0 };
  }

  let result: AdOutcome;
  try {
    if (provider === "hilltop") result = await loadHilltop(container, context);
    else if (provider === "exoclick") result = await loadExoclick(container, context);
    else if (provider === "adcash") result = await loadAdcash(container, context);
    // Video-only provider: never loaded into a banner container.
    else result = outcome(provider, "provider_disabled", "video-only");
  } catch {
    clearContainer(container);
    result = outcome(provider, "network_error", "loader-threw");
  }

  return { ...result, latencyMs: Date.now() - startedAt };
}

/** Test seam: forget which Adcash zones already ran in this document. */
export function resetBannerRuntimeState(): void {
  executedAdcashZones.clear();
}
