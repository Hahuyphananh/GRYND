"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import LogoSmiley from "../images/logo1.png";
import SocialLinks, { REDDIT_COMMUNITY } from "./SocialLinks";
import CookieSettingsLink from "./CookieSettingsLink";

// Solitaire-first footer: say what GRYND is now, keep every real destination
// (play, ladder, rules, GRYND PRO, account), and keep Contact and FAQ one
// click away beside the legal set.
//
// The old "Popular Games" column went with the multi-game product. Archived
// games keep their routes and data; they are simply no longer advertised here.

export default function Footer() {
  const [showScrollTop, setShowScrollTop] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setShowScrollTop(window.scrollY > 300);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const linkClass = "block text-sm text-white/55 transition-colors hover:text-white";
  const heading = "mb-3 text-[11px] font-black uppercase tracking-[0.22em] text-white/35";

  return (
    <footer className="mt-16 border-t border-white/10 bg-[#04060b]">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-5">
          <div className="col-span-2 md:col-span-1">
            <Link href="/" className="inline-block">
              <Image
                src={LogoSmiley}
                alt="GRYND"
                width={150}
                height={60}
                className="w-[130px] object-contain"
              />
            </Link>

            <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/50">
              The competitive home of Klondike Solitaire. One deal, two players,
              a free ranked ladder and results the server verifies.
            </p>

            <SocialLinks testId="footer-social" className="mt-5" />
          </div>

          <div>
            <h2 className={heading}>Play</h2>
            <div className="space-y-2">
              <Link href="/" className={linkClass}>
                Play ranked
              </Link>
              <Link href="/games/solitaire-duel" className={linkClass}>
                Rules &amp; strategy
              </Link>
              <Link href="/classement" className={linkClass}>
                Leaderboard
              </Link>
              <Link href="/upgrade-pro" className={linkClass}>
                GRYND PRO
              </Link>
            </div>
          </div>

          <div>
            <h2 className={heading}>Account</h2>
            <div className="space-y-2">
              <Link href="/profil" className={linkClass}>
                Profile
              </Link>
              <Link href="/stats" className={linkClass}>
                Statistics
              </Link>
              <Link href="/settings" className={linkClass}>
                Settings
              </Link>
              <Link href="/reviews" className={linkClass}>
                Reviews
              </Link>
            </div>
          </div>

          <div>
            <h2 className={heading}>Support</h2>
            <div className="space-y-2">
              <Link href="/faq" className={linkClass}>
                FAQ
              </Link>
              <Link href="/contact" className={linkClass}>
                Contact
              </Link>
              <Link href="/guides" className={linkClass}>
                Guides
              </Link>
              <a
                href={REDDIT_COMMUNITY.href}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
              >
                Reddit community
              </a>
            </div>
          </div>

          <div>
            <h2 className={heading}>Legal</h2>
            <div className="space-y-2">
              <Link href="/terms" className={linkClass}>
                Terms
              </Link>
              <Link href="/privacy-policy" className={linkClass}>
                Privacy
              </Link>
              <Link href="/fair-play" className={linkClass}>
                Fair play
              </Link>
              <Link href="/security-policy" className={linkClass}>
                Security
              </Link>
              <Link href="/accessibility" className={linkClass}>
                Accessibility
              </Link>
              <CookieSettingsLink className={linkClass} />
            </div>
          </div>
        </div>

        <div className="mt-10 border-t border-white/10 pt-6">
          <div className="flex flex-col items-center justify-between gap-3 text-xs text-white/35 md:flex-row">
            <div>© 2026 GRYND. All rights reserved.</div>
            <div className="flex items-center gap-2">
              <Link href="/terms" className="transition-colors hover:text-white">
                Terms
              </Link>
              <span aria-hidden="true">&bull;</span>
              <Link href="/fair-play" className="transition-colors hover:text-white">
                Play responsibly
              </Link>
            </div>
          </div>
        </div>

        {showScrollTop && (
          <button
            onClick={scrollToTop}
            aria-label="Scroll to top"
            className="fixed bottom-24 right-4 z-50 flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-[#04060b]/90 text-white/70 backdrop-blur-xs transition hover:border-white/30 hover:text-white sm:bottom-6 sm:right-6"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </footer>
  );
}
