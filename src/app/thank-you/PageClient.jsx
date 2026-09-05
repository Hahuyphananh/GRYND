"use client";

import { useEffect } from "react";
import { motion } from "framer-motion";
import confetti from "canvas-confetti";
import { useTranslation } from "../../hooks/useTranslation";

// Legacy post-signup landing. Brand-new accounts are now routed to the
// /welcome onboarding flow (see src/app/sync), so this page no longer arms
// the old localStorage tour — it just keeps the welcome confetti for
// anyone who lands here directly.

export default function ThankYouPage() {
  const { t } = useTranslation();

  // Welcome confetti.
  useEffect(() => {
    const brand = ["#FFD700", "#00e5ff", "#FF2D9B", "#00FFA3"];
    const burst = (x, angle) =>
      confetti({
        particleCount: 90,
        angle,
        spread: 65,
        startVelocity: 45,
        origin: { x, y: 0.35 },
        colors: brand,
        disableForReducedMotion: true,
      });
    burst(0.3, 60);
    setTimeout(() => burst(0.7, 120), 250);
    setTimeout(() => burst(0.5, 90), 500);
  }, []);

  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-16"
      style={{ background: "linear-gradient(135deg, #001933 0%, #000d1f 50%, #000814 100%)" }}
    >
      {/* Ambient neon glows */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[42rem] -translate-x-1/2 rounded-full bg-[#00e5ff]/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-48 left-1/4 h-96 w-96 rounded-full bg-[#FF2D9B]/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 right-1/4 h-72 w-72 rounded-full bg-[#00FFA3]/10 blur-3xl" />

      {/* Welcome */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="relative z-10 mb-8 flex flex-col items-center text-center"
      >
        <div className="mb-4 flex h-16 w-16 items-center justify-center">
          <div className="h-14 w-14 rotate-45 rounded-lg border-2 border-[#00e5ff] bg-gradient-to-br from-[#FF2D9B]/20 to-[#00e5ff]/20 shadow-[0_0_30px_rgba(0,229,255,0.5)]" />
        </div>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.3em] text-[#00e5ff]">
          ✦ {t("thankYou.subtitle")}
        </p>
        <h1 className="bg-gradient-to-r from-[#FFD700] via-[#FFB300] to-[#FFD700] bg-clip-text text-4xl font-extrabold tracking-tight text-transparent drop-shadow-[0_0_20px_rgba(255,215,0,0.35)] sm:text-5xl md:text-6xl">
          {t("thankYou.title")}
        </h1>
      </motion.div>

      {/* Free tokens card */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.2, ease: "easeOut" }}
        className="relative z-10 mb-10 w-full max-w-md rounded-3xl border border-[#00e5ff]/40 bg-[#040d24]/80 p-8 text-center shadow-[0_0_40px_rgba(0,229,255,0.15)] backdrop-blur-md"
      >
        <p className="text-5xl font-extrabold tracking-tight text-[#00e5ff] drop-shadow-[0_0_18px_rgba(0,229,255,0.6)]">
          {t("thankYou.tokensTitle").split(" ")[0]}
        </p>
        <p className="mt-1 text-sm font-bold uppercase tracking-widest text-[#d8fbff]/80">
          {t("thankYou.tokensTitle").split(" ").slice(1).join(" ")}
        </p>
        <p className="mt-4 text-sm leading-relaxed text-[#9dd8ff]">{t("thankYou.tokensDesc")}</p>
      </motion.div>

      {/* Start playing */}
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.35, ease: "easeOut" }}
        className="relative z-10"
      >
        <button
          type="button"
          onClick={() => window.location.assign("/games")}
          className="rounded-2xl bg-gradient-to-r from-[#FFD700] to-[#FFB300] px-10 py-4 text-lg font-extrabold text-black shadow-[0_0_30px_rgba(255,215,0,0.5)] transition-all hover:brightness-110 active:scale-[0.98]"
        >
          {t("thankYou.play")} →
        </button>
      </motion.div>

    </div>
  );
}
