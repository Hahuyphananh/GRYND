"use client";

// src/components/ads/BannerSlotClient.tsx
//
// The browser half of the unified banner slot.
//
// ONE CONTAINER, ONE PROVIDER AT A TIME. The chain is sequential (`runAdChain`):
// the next provider's tag is not touched until the previous attempt has
// resolved, and a fill ends the chain. A failure clears the container first, so
// two providers can never draw into it together.
//
// ONE OPPORTUNITY PER DOCUMENT + PLACEMENT. The id comes from
// `bannerOpportunityId`, and the claim is held by this component instance
// (React's development double-effect re-enters with the same owner; a second
// mounted slot is refused). A served opportunity cannot fall back.
//
// CONSENT IS A FILTER, NOT A FAILURE. Every provider is consent-gated by
// default, so none is requested while consent is undecided or declined. A
// provider is removed before the chain starts and is never reported as an
// error. Accepting later re-runs the effect for the still-unserved opportunity.
// `NEXT_PUBLIC_*_REQUIRES_CONSENT=false` is the only way to exempt one, and it
// is deliberately an explicit operator choice.
//
// GATES THAT REMAIN IN THE BROWSER: the exact route for the placement, the
// shared gameplay classifier, and the consent record. The server has already
// checked switches, configuration, placement, native shell and entitlement.

import { useEffect, useRef, useState } from "react";

import AdCodeMarker from "../AdCodeMarker";
import { COOKIE_CONSENT_EVENT, getCookieConsent, type CookieConsent } from "../../lib/cookieConsent";
import { isMatchHref } from "../../lib/matchNavigation";
import {
  exoclickConsentSatisfied,
  exoclickRequiresConsent,
} from "../../lib/exoclick/config";
import {
  adcashConsentSatisfied,
  adcashRequiresConsent,
} from "../../lib/adcash/config";
import {
  hilltopBannerRequiresConsent,
  hilltopConsentSatisfied,
} from "../../lib/hilltop/config";
import {
  bannerRouteMatchesPlacement,
  type AdProviderId,
  type BannerPlacement,
} from "../../lib/ads/core/types";
import { runAdChain } from "../../lib/ads/core/chain";
import { rotatedProviderOrder } from "../../lib/ads/core/order";
import {
  bannerOpportunityId,
  claimOpportunity,
} from "../../lib/ads/core/opportunity";
import { outcomeMetric, reportAdEvent } from "../../lib/ads/core/report";
import { bannerChainBudgetMs } from "../../lib/ads/banners/limits";
import { loadBannerProvider } from "../../lib/ads/banners/runtime";

type Phase = "idle" | "loading" | "filled" | "unavailable";

function ownerId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `owner-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function providerRequiresConsent(provider: AdProviderId): boolean {
  if (provider === "exoclick") return exoclickRequiresConsent();
  if (provider === "adcash") return adcashRequiresConsent();
  // The video-only provider can never reach this chain; consent is still
  // required so a future mis-wiring fails closed rather than open.
  if (provider === "adexchange") return true;
  return hilltopBannerRequiresConsent();
}

function providerConsentSatisfied(
  provider: AdProviderId,
  consent: CookieConsent | null,
): boolean {
  if (provider === "exoclick") return exoclickConsentSatisfied(consent);
  if (provider === "adcash") return adcashConsentSatisfied(consent);
  if (provider === "adexchange") return consent === "accepted";
  return hilltopConsentSatisfied(consent);
}

export default function BannerSlotClient({
  placement,
  providers,
}: {
  placement: BannerPlacement;
  providers: AdProviderId[];
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const ownerRef = useRef<string>(ownerId());
  const finishedRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("idle");
  // Start at null so the server and the hydrated client agree. The effect
  // reads the stored record immediately after mount (and on every change).
  const [consent, setConsent] = useState<CookieConsent | null>(null);
  const [consentReady, setConsentReady] = useState(false);

  useEffect(() => {
    const onChange = () => setConsent(getCookieConsent());
    setConsent(getCookieConsent());
    setConsentReady(true);
    window.addEventListener(COOKIE_CONSENT_EVENT, onChange);
    return () => window.removeEventListener(COOKIE_CONSENT_EVENT, onChange);
  }, []);

  const allowed = providers.filter(
    (provider) =>
      !providerRequiresConsent(provider) ||
      providerConsentSatisfied(provider, consent),
  );
  const allowedKey = allowed.join(",");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    if (!consentReady) return undefined;
    if (finishedRef.current) return undefined;

    // Exact route + gameplay classifier, as an independent browser-side belt.
    if (!bannerRouteMatchesPlacement(window.location.pathname, placement)) {
      setPhase("unavailable");
      return undefined;
    }
    if (isMatchHref(`${window.location.pathname}${window.location.search}`)) {
      setPhase("unavailable");
      return undefined;
    }

    if (allowed.length === 0) {
      // Consent removed every provider: draw no reserved box, and leave the
      // opportunity unclaimed so accepting later can still use it.
      return undefined;
    }

    const id = bannerOpportunityId(placement);
    if (!claimOpportunity(id, ownerRef.current)) {
      setPhase("unavailable");
      return undefined;
    }

    const controller = new AbortController();
    setPhase("loading");

    const opportunity = { id, kind: "banner" as const, placement };
    // ROTATION: the opportunity id picks which eligible provider goes first, so
    // Hilltop and Adcash alternate across documents and placements instead of
    // the configured first provider taking every slot (Hilltop also loads at
    // most once per tab, which would starve later banners). The order is stable
    // for this opportunity, so a re-render cannot reorder a running chain.
    const order = rotatedProviderOrder(allowed, id);
    let attemptSeq = 0;

    void runAdChain({
      opportunity,
      order,
      totalBudgetMs: bannerChainBudgetMs(),
      signal: controller.signal,
      attempt: async (provider, budgetMs) => {
        // Every attempt gets its OWN child container. A provider that fills
        // after its deadline writes into a hidden, detached-from-layout box,
        // never beside the provider that won the next attempt. Only one child
        // is ever visible.
        const attemptHost = document.createElement("div");
        attemptSeq += 1;
        attemptHost.id = `grynd-ad-banner-${placement}-${attemptSeq}`;
        attemptHost.setAttribute("data-grynd-banner-attempt", provider);
        attemptHost.className = "flex w-full items-center justify-center";
        host.appendChild(attemptHost);

        reportAdEvent({
          metric: "ad_request",
          kind: "banner",
          provider,
          placement,
          opportunityId: id,
        });

        const outcome = await loadBannerProvider(provider, attemptHost, {
          placement,
          opportunityId: id,
          budgetMs,
          signal: controller.signal,
        });

        if (outcome.status !== "filled") {
          attemptHost.style.display = "none";
          attemptHost.setAttribute("aria-hidden", "true");
        }

        return outcome;
      },
      onOutcome: (result) => {
        reportAdEvent({
          metric: outcomeMetric(result.status),
          kind: "banner",
          provider: result.provider,
          placement,
          opportunityId: id,
          status: result.status,
          reason: result.reason,
          latencyMs: result.latencyMs,
          // A banner creative appearing is a fill, not a verified impression:
          // display networks give us no impression callback.
          verifiedImpression: false,
        });
      },
    }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.filled) {
        finishedRef.current = true;
        setPhase("filled");
        return;
      }
      // Not filled: keep the host mounted (hidden) so a later consent change
      // can add the consent-gated providers and run a fresh attempt for this
      // still-unserved opportunity.
      host.replaceChildren();
      setPhase("unavailable");
    });

    return () => {
      controller.abort();
    };
    // `allowedKey` is the stable identity of the consent-filtered list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement, allowedKey, consentReady]);

  if (allowed.length === 0) return null;

  const unavailable = phase === "unavailable";

  return (
    <>
      {/* Flags the document as ad-carrying, so entering a match is a document
          navigation and provider code cannot follow the player onto a board. */}
      {!unavailable && <AdCodeMarker />}
      {!unavailable && (
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.2em] text-[#9dd8ff]/50">
          Advertisement
        </span>
      )}
      <div
        ref={hostRef}
        id={`grynd-ad-banner-${placement}`}
        data-grynd-banner={phase}
        role="group"
        aria-label="Advertisement"
        aria-hidden={unavailable || undefined}
        className="mx-auto flex w-full max-w-[728px] items-center justify-center overflow-hidden"
        style={{ display: unavailable ? "none" : undefined, minHeight: unavailable ? undefined : 250 }}
      />
    </>
  );
}
