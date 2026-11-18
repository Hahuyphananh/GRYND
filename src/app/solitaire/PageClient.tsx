"use client";

import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import SoloSolitaireGame from "../../components/solitaire-duel/SoloSolitaireGame";
import { PageHeader } from "../../components/ui";

export default function SolitairePageClient() {
  return (
    <div className="relative min-h-screen bg-[color:var(--bg-page)] pb-24 text-[color:var(--text-primary)] md:pb-0">
      <NavigationBar currentPath="/solitaire" />
      <main className="mx-auto max-w-6xl px-4 pt-24 sm:px-6 md:pt-28">
        <PageHeader
          kicker="GRYND · solo"
          title="Solitaire, on your own terms"
          description="No opponent, no queue, no waiting. Classic Klondike with the same cards and rules as ranked play, timed from the first deal. Solo results are kept entirely separate from ranked and never change Elo."
        />
        <SoloSolitaireGame mode="solo" />
      </main>
      <Footer />
    </div>
  );
}
