"use client";

// src/app/PageClient.jsx
//
// GRYND's public home page, Solitaire-first.
//
// The platform now presents one competitive game: Solitaire Duel. This page
// explains it, puts the Play action first, and links to the real Solitaire
// rankings. Archived games keep their implementations and history; they are
// simply not part of the public experience (src/lib/gameAvailability.js).

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth, useUser } from "@clerk/nextjs";
import NavigationBar from "../components/navigation-bar";
import Footer from "../components/Footer";
import InteractiveCasinoBg from "../components/InteractiveCasinoBg";
import { clearSessionArtifacts } from "../lib/security/sessionCleanup";

export default function MainComponent({ adSlot = null, hilltopSlot = null }) {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const { user } = useUser();
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [termsLoading, setTermsLoading] = useState(true);

  useEffect(() => {
    if (!isSignedIn || !isLoaded) return;
    let cancelled = false;
    fetch("/api/user/terms-status")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.success && !data.termsAccepted) {
          setShowTermsModal(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTermsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, isLoaded]);

  const handleAcceptTerms = async () => {
    try {
      const res = await fetch("/api/user/accept-terms", { method: "POST" });
      const data = await res.json();
      if (data.success) setShowTermsModal(false);
    } catch {
      // the gate simply persists until the next successful accept
    }
  };

  const handleRejectTerms = async () => {
    if (signOut) {
      clearSessionArtifacts();
      await signOut();
    }
  };

  const features = [
    {
      title: "One deal, two players",
      body: "The server generates one deterministic Klondike deal and gives both seats the exact same starting position. Nobody gets luckier cards.",
    },
    {
      title: "Free ranked play",
      body: "No stake, no entry fee, no tokens. Ranked Solitaire moves your Elo rating and your trophy ladder instead.",
    },
    {
      title: "Server-authoritative",
      body: "Every move, the clock, the progress and the result are validated and held by the server. The browser never decides a match.",
    },
  ];

  const steps = [
    { title: "Create a free account", body: "Your account carries your Solitaire rating, trophies and match history." },
    { title: "Play the bot first", body: "An unrated practice match on the same deal, so your first ranked game is not a guess." },
    { title: "Queue for a real duel", body: "Matchmaking pairs you with another player for the same deal." },
    { title: "Solve it first", body: "The first player to put all 52 cards on the foundations wins. Progress decides if the clock runs out." },
  ];

  return (
    <div className="relative min-h-screen cyberpunk-grid pb-32 md:pb-0">
      <NavigationBar currentPath="/" />

      <section className="relative mt-4 flex min-h-[60vh] items-center overflow-hidden px-4 sm:mt-8">
        <InteractiveCasinoBg />
        <div className="pointer-events-none absolute inset-0 z-10 bg-black/70" />
        <div className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(circle_at_30%_20%,rgba(0,229,255,0.15),transparent_60%)] mix-blend-screen" />

        <div className="relative z-20 mx-auto max-w-4xl text-center">
          <p className="mb-3 text-xs font-black uppercase tracking-[0.35em] text-[#00e5ff]">
            GRYND
          </p>
          <h1 className="text-[2rem] font-black uppercase leading-[1.1] tracking-[0.06em] sm:text-6xl">
            <span className="block text-[#f5ff3b]">The competitive home</span>
            <span className="block bg-gradient-to-r from-[#00e5ff] via-[#7cefff] to-[#ff4fd8] bg-clip-text text-transparent">
              of Solitaire
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-[#d8fbff] sm:text-xl">
            Classic Klondike, played one-on-one against a real person. The same
            deal, the same clock, and a rating that moves only on validated
            results.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/games/solitaire-duel"
              className="w-full rounded-lg border border-[#f5ff3b]/60 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-8 py-4 text-lg font-bold text-[#1f1700] shadow-[0_0_35px_rgba(245,255,59,0.5)] transition hover:shadow-[0_0_55px_rgba(245,255,59,0.8)] sm:w-auto"
            >
              Play Solitaire Duel
            </Link>
            <Link
              href="/classement"
              className="w-full rounded-lg border border-[#00e5ff]/50 bg-[#00e5ff]/10 px-8 py-4 text-base font-semibold text-[#d8fbff] transition hover:bg-[#00e5ff]/20 sm:w-auto"
            >
              View Rankings
            </Link>
          </div>

          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-[#9dd8ff]">
            Free ranked play · Real opponents · Trophies preserved
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12">
        <div className="grid gap-4 sm:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-[#00e5ff]/25 bg-[#040d24]/70 p-6 backdrop-blur-sm"
            >
              <h2 className="text-lg font-black text-[#f5ff3b]">{feature.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-[#c9f7ff]/90">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-12">
        <h2 className="text-2xl font-black text-[#f5ff3b]">How ranked Solitaire works</h2>
        <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((step, index) => (
            <li
              key={step.title}
              className="rounded-xl border border-[#00e5ff]/20 bg-[#061329] p-5"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full border border-[#00e5ff]/50 bg-[#00e5ff]/10 text-sm font-bold text-[#00e5ff]">
                {index + 1}
              </span>
              <p className="mt-3 font-bold text-[#d8fbff]">{step.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-[#9dd8ff]">{step.body}</p>
            </li>
          ))}
        </ol>

        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <Link href="/games/solitaire-duel" className="text-[#00e5ff] underline underline-offset-2">
            Solitaire Duel rules and strategy
          </Link>
          <Link href="/classement" className="text-[#00e5ff] underline underline-offset-2">
            Solitaire rankings
          </Link>
          <Link href="/guides" className="text-[#00e5ff] underline underline-offset-2">
            Guides
          </Link>
          <Link href="/faq" className="text-[#00e5ff] underline underline-offset-2">
            FAQ
          </Link>
        </div>
      </section>

      {hilltopSlot}

      {adSlot}

      <Footer />

      {showTermsModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="terms-modal-title"
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[#00e5ff]/30 bg-gradient-to-b from-[#030817] to-[#0a1a3d] p-6 md:p-8"
          >
            <h2 id="terms-modal-title" className="text-2xl font-black text-[#f5ff3b]">
              Terms &amp; Conditions
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-[#c9f7ff]/90">
              GRYND is a free competitive Solitaire platform. Play is for rating
              and trophies only — there is no wagering, no entry fee and no
              cash-out. By continuing you agree to the{" "}
              <Link href="/terms" className="text-[#00e5ff] underline">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy-policy" className="text-[#00e5ff] underline">
                Privacy Policy
              </Link>
              .
            </p>
            {termsLoading ? null : (
              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={handleRejectTerms}
                  className="rounded-lg border border-red-500/40 bg-red-500/10 px-5 py-2.5 text-sm font-bold text-red-300"
                >
                  Decline and sign out
                </button>
                <button
                  type="button"
                  onClick={handleAcceptTerms}
                  className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff] px-5 py-2.5 text-sm font-bold text-[#041125]"
                >
                  I agree
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
