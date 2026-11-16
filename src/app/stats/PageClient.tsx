"use client";

// src/app/stats/PageClient.tsx
//
// The /stats shell: GRYND's standard chrome (background, navbar, footer) around
// the dashboard, matching /profil and /classement.
//
// NOTE — no ad loader here, deliberately. /stats is a GRYND PRO analytics
// surface (members are ad-free), and the ad model's allow-list in
// src/components/AdSenseScript.tsx only names the pages that monetise browsing.

import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import PerformanceDashboard from "../../components/stats/PerformanceDashboard";
import SolitaireAcademyStats from "../../components/stats/SolitaireAcademyStats";
import { useTranslation } from "../../hooks/useTranslation";

export default function StatsPageClient({
  signedIn,
  pro,
  membershipUnavailable = false,
}: {
  signedIn: boolean;
  pro: boolean;
  /** The server could not READ the membership (timeout/failure) — not the same as free. */
  membershipUnavailable?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="relative min-h-screen bg-[#05070d] text-white">
      <NavigationBar currentPath="/stats" />

      <main className="relative mx-auto w-full max-w-6xl px-4 pb-16 pt-24 sm:px-6">
        <header className="mb-6">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#00e5ff]">
            GRYND PRO
          </p>
          <h1 className="mt-1 text-3xl font-black text-white sm:text-4xl">
            {t("stats.title")}
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-[#9dd8ff]/80">{t("stats.subtitle")}</p>
        </header>

        <SolitaireAcademyStats
          signedIn={signedIn}
          pro={pro}
          membershipUnavailable={membershipUnavailable}
        />

        <PerformanceDashboard
          signedIn={signedIn}
          pro={pro}
          membershipUnavailable={membershipUnavailable}
        />
      </main>

      <Footer />
    </div>
  );
}
