"use client";

// OnboardingTour — a lightweight spotlight tour (driver.js style).
//
// Usage: render elements with `data-tour="someId"` attributes, then mount
// <OnboardingTour steps={[{ id, title, description }]} onFinish={} onSkip={} />.
// The overlay dims the page and shows a neon spotlight hole around the
// current step's element, with an animated tooltip explaining it.
//
// Built on framer-motion (already a dependency) — no new packages.

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslation } from "../hooks/useTranslation";

export const TOUR_STORAGE_PREFIX = "goonbet_tour_";

/** Per-user storage key so a tour shown to one account never blocks another. */
export function getTourStorageKey(userId) {
  return userId ? `${TOUR_STORAGE_PREFIX}${userId}` : TOUR_STORAGE_PREFIX;
}

const SPOT_PADDING = 8;
const TOOLTIP_W = 300;

function pickPlacement(rect) {
  const spaceBelow = window.innerHeight - (rect.top + rect.height);
  const spaceAbove = rect.top;
  if (spaceBelow > 150) return "bottom";
  if (spaceAbove > 150) return "top";
  if (window.innerWidth - (rect.left + rect.width) > TOOLTIP_W + 40) return "right";
  if (rect.left > TOOLTIP_W + 40) return "left";
  return "bottom";
}

export default function OnboardingTour({ steps, onFinish, onSkip }) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState(null);
  const [ready, setReady] = useState(false);
  const rafRef = useRef(null);

  const step = steps[index];
  const isLast = index === steps.length - 1;

  const measure = useCallback((targetId) => {
    const el = document.querySelector(`[data-tour="${targetId}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }, []);

  // Keep the spotlight glued to the target across scroll/resize.
  useEffect(() => {
    if (!step) return undefined;
    const refresh = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const next = measure(step.id);
        if (next) setRect(next);
        else console.warn(`[OnboardingTour] no element with data-tour="${step.id}"`);
      });
    };
    window.addEventListener("scroll", refresh, true);
    window.addEventListener("resize", refresh);
    refresh();
    return () => {
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("resize", refresh);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [step, measure]);

  // Scroll the target into view on step change, then measure once settled.
  useEffect(() => {
    if (!step) return undefined;
    const el = document.querySelector(`[data-tour="${step.id}"]`);
    if (!el) {
      console.warn(`[OnboardingTour] no element with data-tour="${step.id}"`);
      return undefined;
    }
    el.scrollIntoView({ block: "center", behavior: "smooth", inline: "nearest" });
    const timer = setTimeout(() => {
      const next = measure(step.id);
      if (next) setRect(next);
    }, 400);
    return () => clearTimeout(timer);
  }, [step?.id, measure]);

  // Escape skips the tour.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onSkip?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const next = () => {
    if (isLast) onFinish?.();
    else setIndex((i) => i + 1);
  };

  if (!step) return null;

  const placement = rect ? pickPlacement(rect) : "bottom";
  const hole = rect
    ? {
        top: rect.top - SPOT_PADDING,
        left: rect.left - SPOT_PADDING,
        width: rect.width + SPOT_PADDING * 2,
        height: rect.height + SPOT_PADDING * 2,
      }
    : null;

  // Position the tooltip relative to the spotlight hole.
  let tooltipStyle = {};
  if (hole) {
    if (placement === "bottom") {
      const left = Math.min(
        Math.max(hole.left + hole.width / 2 - TOOLTIP_W / 2, 12),
        window.innerWidth - TOOLTIP_W - 12,
      );
      tooltipStyle = { top: hole.top + hole.height + 14, left };
    } else if (placement === "top") {
      const left = Math.min(
        Math.max(hole.left + hole.width / 2 - TOOLTIP_W / 2, 12),
        window.innerWidth - TOOLTIP_W - 12,
      );
      tooltipStyle = { bottom: window.innerHeight - hole.top + 14, left };
    } else if (placement === "right") {
      tooltipStyle = { left: hole.left + hole.width + 16, top: hole.top + hole.height / 2 - 70 };
    } else {
      tooltipStyle = { right: window.innerWidth - hole.left + 16, top: hole.top + hole.height / 2 - 70 };
    }
  }

  // Neon diamond marker pointing at the spotlight from the tooltip edge.
  // Guarded on `hole` — it's null on the server / before first measure.
  const markerStyle = hole
    ? placement === "bottom"
      ? { top: hole.top + hole.height + 6, left: hole.left + hole.width / 2 - 7 }
      : placement === "top"
        ? { top: hole.top - 22, left: hole.left + hole.width / 2 - 7 }
        : placement === "right"
          ? { left: hole.left + hole.width + 8, top: hole.top + hole.height / 2 - 7 }
          : { left: hole.left - 22, top: hole.top + hole.height / 2 - 7 }
    : null;

  return (
    <>
      {/* Click-blocker: everything below the spotlight is inert during the tour. */}
      <div className="fixed inset-0 z-[90]" aria-hidden="true" />

      {/* Spotlight hole + neon ring + dimming halo (one box-shadow stack). */}
      {ready && hole && (
        <motion.div
          key={step.id}
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="pointer-events-none fixed z-[90] rounded-2xl"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            boxShadow:
              "0 0 0 3px rgba(0,229,255,0.9), 0 0 22px 2px rgba(0,229,255,0.55), 0 0 0 9999px rgba(3,10,28,0.85)",
          }}
        />
      )}

      {/* Diamond connector marker */}
      {ready && hole && (
        <motion.div
          initial={{ opacity: 0, scale: 0 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.15, duration: 0.2 }}
          className="pointer-events-none fixed z-[90] h-3.5 w-3.5 rotate-45 border border-[#00e5ff] bg-[#040d24] shadow-[0_0_10px_rgba(0,229,255,0.7)]"
          style={markerStyle}
        />
      )}

      {/* Tooltip */}
      <AnimatePresence mode="wait">
        <motion.div
          key={step.id}
          initial={{ opacity: 0, y: placement === "bottom" ? 14 : -14, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: placement === "bottom" ? 8 : -8, scale: 0.97 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="fixed z-[91] w-[300px] rounded-2xl border border-[#00e5ff]/50 bg-[#040d24] p-4 shadow-[0_0_30px_rgba(0,229,255,0.25)]"
          style={tooltipStyle}
          role="dialog"
          aria-label={step.title}
        >
          <p className="mb-1 text-sm font-extrabold uppercase tracking-widest text-[#00e5ff]">
            {step.title}
          </p>
          <p className="mb-3 text-sm leading-relaxed text-[#d8fbff]/90">{step.description}</p>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              {steps.map((s, i) => (
                <span
                  key={s.id}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === index ? "w-4 bg-[#FFD700] shadow-[0_0_8px_rgba(255,215,0,0.8)]" : "w-1.5 bg-[#00e5ff]/40"
                  }`}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onSkip}
                className="text-xs font-semibold text-[#9dd8ff]/70 transition-colors hover:text-[#d8fbff]"
              >
                {t("tour.skip")}
              </button>
              {index > 0 && (
                <button
                  type="button"
                  onClick={() => setIndex((i) => i - 1)}
                  className="rounded-lg border border-[#00e5ff]/40 px-3 py-1.5 text-xs font-bold text-[#00e5ff] transition-colors hover:bg-[#00e5ff]/10"
                >
                  {t("tour.back")}
                </button>
              )}
              <button
                type="button"
                onClick={next}
                className={`rounded-lg px-4 py-1.5 text-xs font-bold transition-all ${
                  isLast
                    ? "bg-gradient-to-r from-[#FFD700] to-[#FFB300] text-black shadow-[0_0_16px_rgba(255,215,0,0.6)] hover:brightness-110"
                    : "bg-[#00e5ff] text-black shadow-[0_0_14px_rgba(0,229,255,0.6)] hover:brightness-110"
                }`}
              >
                {isLast ? t("tour.done") : t("tour.next")}
              </button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </>
  );
}
