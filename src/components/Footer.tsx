"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import LogoSmiley from "../images/logo1.png";
import SocialLinks, { REDDIT_COMMUNITY } from "./SocialLinks";
import CookieSettingsLink from "./CookieSettingsLink";

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

  const linkClass =
    "block text-[#c9f7ff] transition-all duration-200 hover:translate-x-1 hover:text-[#f5ff3b] hover:drop-shadow-[0_0_6px_rgba(245,255,59,0.4)]";

  return (
    <footer className="border-t border-[#00e5ff]/20 bg-[#030712]">
      <div className="mx-auto max-w-7xl px-4 py-12">

        {/* TOP GRID */}
        <div className="grid grid-cols-1 gap-10 md:grid-cols-4">

          {/* BRAND */}
          <div>
            <Link href="/" className="inline-block">
              <Image
                src={LogoSmiley}
                alt="GRYND Logo"
                width={150}
                height={60}
                className="w-[140px] object-contain drop-shadow-[0_0_10px_rgba(245,255,59,0.25)]"
              />
            </Link>

            <p className="mt-4 text-sm leading-relaxed text-[#7dd3fc]">
              Skill-based multiplayer games and competitive entertainment platform.
            </p>

            {/* SOCIALS — same component the contact page mounts, so the two
                can't list different accounts. */}
            <SocialLinks testId="footer-social" className="mt-5" />

            {/* Product Hunt featured badge — third-party badge image, so it is
                a plain <img> rather than next/image (no remote-domain config). */}
            <a
              href="https://www.producthunt.com/products/grynd?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-grynd"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GRYND on Product Hunt"
              className="mt-5 inline-block"
            >
              <img
                alt="GRYND - Competitive multiplayer games, built to outplay. | Product Hunt"
                width={250}
                height={54}
                src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1251858&theme=dark&t=1789866264006"
                className="h-[54px] w-[250px]"
              />
            </a>
          </div>

          {/* NAVIGATION */}
          <div>
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-[#f5ff3b]">
              Navigation
            </h2>

            <div className="space-y-2 text-sm">
              <Link href="/" className={linkClass}>
                Home
              </Link>

              <Link href="/games" className={linkClass}>
                Games
              </Link>

              <Link href="/classement" className={linkClass}>
                Rankings
              </Link>

              <Link href="/profil" className={linkClass}>
                Profile
              </Link>

              <Link href="/contact" className={linkClass}>
                Contact
              </Link>

              <Link href="/reviews" className={linkClass}>
                Reviews
              </Link>

              {/* COMMUNITY — the subreddit is a destination rather than site
                  navigation, so it opens in a new tab under the same
                  rel="noopener noreferrer" the social row and the Product Hunt
                  badge use. The URL is the shared social list's own entry, so
                  the icon tile and this label can never point at different
                  places. */}
              <a
                href={REDDIT_COMMUNITY.href}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
              >
                Reddit Community
              </a>
            </div>
          </div>

          {/* GAMES */}
          <div>
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-[#f5ff3b]">
              Popular Games
            </h2>

            <div className="space-y-2 text-sm">
              <Link href="/games/neon-flush" className={linkClass}>
                Neon Flush
              </Link>

              <Link href="/games/chess" className={linkClass}>
                Chess
              </Link>

              <Link href="/games/pool-masters" className={linkClass}>
                Pool Masters
              </Link>

              <Link href="/games/dice-flush" className={linkClass}>
                Dice Flush
              </Link>

              <Link href="/games/precision" className={linkClass}>
                Precision
              </Link>

              <Link
                href="/games"
                className="mt-3 inline-flex rounded-lg border border-[#00e5ff]/30 bg-[#00e5ff]/10 px-3 py-2 text-xs font-medium text-[#67f9ff] transition-all duration-200 hover:translate-x-1 hover:bg-[#00e5ff]/20 hover:shadow-[0_0_12px_rgba(0,229,255,0.3)]"
              >
                View All Games
              </Link>
            </div>
          </div>

          {/* LEGAL */}
          <div>
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-[#f5ff3b]">
              Legal
            </h2>

            <div className="space-y-2 text-sm">
              <Link href="/security-policy" className={linkClass}>
                Security Policy
              </Link>

              <Link href="/privacy-policy" className={linkClass}>
                Privacy Policy
              </Link>

              <Link href="/terms" className={linkClass}>
                Terms & Conditions
              </Link>

              <Link href="/fair-play" className={linkClass}>
                Fair Play
              </Link>

              <Link href="/accessibility" className={linkClass}>
                Accessibility
              </Link>

              <Link href="/faq" className={linkClass}>
                FAQ
              </Link>

              {/* Withdrawal entrypoint — GDPR art. 7(3) requires that a
                  choice be as easy to change as it was to make. Reopens
                  Google's CMP or our banner, whichever owns the visitor. */}
              <CookieSettingsLink className={linkClass} />
            </div>
          </div>
        </div>

        {/* BOTTOM BAR */}
        <div className="mt-10 border-t border-[#00e5ff]/10 pt-6">
          <div className="flex flex-col items-center justify-between gap-3 text-xs text-[#6b91b3] md:flex-row">
            <div>© 2026 GRYND. All rights reserved.</div>

            <div className="flex items-center gap-2">
              <Link href="/terms" className="transition-colors hover:text-[#f5ff3b]">
                18+ only
              </Link>
              <span>&bull;</span>
              <Link href="/fair-play" className="transition-colors hover:text-[#f5ff3b]">
                Play responsibly
              </Link>
            </div>
          </div>
        </div>

        {/* BACK TO TOP BUTTON */}
        {showScrollTop && (
          <button
            onClick={scrollToTop}
            aria-label="Scroll to top"
            className="fixed bottom-24 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-[#00e5ff]/40 bg-[#030712]/90 text-[#00e5ff] shadow-[0_0_16px_rgba(0,229,255,0.3)] backdrop-blur-sm transition-all duration-300 hover:scale-110 hover:border-[#00e5ff]/70 hover:shadow-[0_0_24px_rgba(0,229,255,0.6)] active:scale-95 sm:bottom-6 sm:right-6"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </footer>
  );
}