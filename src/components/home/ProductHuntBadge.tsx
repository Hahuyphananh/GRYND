"use client";

// THE PRODUCT HUNT BADGE, IN THE PAGE'S THEME.
//
// Product Hunt ships one badge image per theme (`?theme=dark|light` — their own
// parameter, not a CSS filter). The site defaults to dark, but a visitor who
// flips the light/dark switch should not be left with a black badge on a light
// page, so this component mirrors <html data-theme> onto the badge — the same
// signal Glitch and the solitaire board theme already read.
//
// The server renders the DARK badge (the <!-- theme --> bootstrap in
// src/app/layout.tsx defaults the document to dark before paint), and the
// client state starts at "dark" too, so hydration matches; the effect then
// corrects it for a light-mode visitor and keeps following the toggle.
//
// It is plain markup — one <a> and one <img> from Product Hunt's CDN. No
// script, no third-party JavaScript on the home page for this.

import { useEffect, useState } from "react";

/** The badge Product Hunt issues for the GRYND listing (post 1251858). */
const POST_ID = "1251858";
const LISTING_HREF =
  "https://www.producthunt.com/products/grynd?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-grynd";

type BadgeTheme = "dark" | "light";

const badgeSrc = (theme: BadgeTheme): string =>
  `https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=${POST_ID}&theme=${theme}`;

export default function ProductHuntBadge() {
  const [theme, setTheme] = useState<BadgeTheme>("dark");

  useEffect(() => {
    const read = (): BadgeTheme =>
      document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";

    setTheme(read());

    // The toggle writes data-theme on <html> (src/context/ThemeContext.js);
    // following the attribute is what keeps the badge in step with it.
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <a
      href={LISTING_HREF}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="GRYND on Product Hunt — view the listing"
      data-testid="product-hunt-badge"
      className="inline-flex shrink-0 rounded-md transition-transform duration-200 hover:-translate-y-0.5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Product Hunt
          serves the badge as an SVG; next/image would need the host
          allow-listed and an SVG passthrough for no benefit. */}
      <img
        src={badgeSrc(theme)}
        alt="GRYND — competitive Solitaire on Product Hunt"
        width={250}
        height={54}
        // Their CDN asset, not a layout-critical image: lazy is correct.
        loading="lazy"
        decoding="async"
        data-badge-theme={theme}
        className="h-auto w-[250px]"
      />
    </a>
  );
}
