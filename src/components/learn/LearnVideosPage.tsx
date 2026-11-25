"use client";

import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";

import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import AcademyVideoSection from "./AcademyVideoSection";
import LearnSubnav from "./LearnSubnav";
import { useTranslation } from "../../hooks/useTranslation";

export default function LearnVideosPage() {
  const { t } = useTranslation();

  return (
    <div className="relative min-h-screen overflow-hidden bg-page pb-24 text-white md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(ellipse_at_top,rgba(0,229,255,0.12),transparent_62%)]"
      />
      <NavigationBar currentPath="/learn" />

      <main className="relative mx-auto max-w-6xl px-4 pt-24 sm:px-6 md:pt-28">
        <Link
          href="/learn"
          className="inline-flex items-center gap-2 text-xs font-bold text-white/55 underline-offset-4 transition hover:text-white hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
        >
          <IconArrowLeft size={15} aria-hidden="true" />
          {t("learn.subnav.back")}
        </Link>

        <LearnSubnav active="videos" />

        <AcademyVideoSection />
      </main>

      <Footer />
    </div>
  );
}
