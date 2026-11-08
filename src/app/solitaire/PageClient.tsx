"use client";

import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import SoloSolitaireGame from "../../components/solitaire-duel/SoloSolitaireGame";

export default function SolitairePageClient() {
  return (
    <div className="relative min-h-screen bg-[#05070d] pb-24 text-white md:pb-0">
      <NavigationBar currentPath="/solitaire" />
      <main className="mx-auto max-w-6xl px-4 pt-24 sm:px-6 md:pt-28">
        <p className="text-[11px] font-black uppercase tracking-[0.4em] text-cyan-300/80">
          GRYND · solo
        </p>
        <h1 className="mt-3 max-w-3xl text-4xl font-black leading-[0.95] tracking-tight sm:text-5xl">
          Solitaire, on your own terms
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-white/60 sm:text-base">
          No opponent, no queue, no waiting. Classic Klondike with the same cards
          and rules as ranked play, timed from the first deal. Solo results are
          kept entirely separate from ranked and never change Elo.
        </p>
        <SoloSolitaireGame mode="solo" />
      </main>
      <Footer />
    </div>
  );
}
