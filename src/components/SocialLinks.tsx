"use client";

// The official GRYND profiles, in the order they're shown. One list, one
// renderer: the site-wide footer and the contact page both mount this
// component, so adding a network or fixing a URL lands in every surface at once.
import {
  IconBrandInstagram,
  IconBrandLinkedin,
  IconBrandProducthunt,
  IconBrandReddit,
  IconBrandTiktok,
  IconBrandX,
  IconBrandYoutube,
} from "@tabler/icons-react";

// The official GRYND subreddit — the community hub, and the one network here
// that is a place to TALK rather than a feed to follow, so it leads the row.
//
// Exported on its own because a surface that renders a labelled LINK rather
// than an icon tile (the footer's "Reddit Community" entry) must reuse this
// exact URL: a second hardcoded copy is how the two drift apart.
// The URL is the subreddit as given, with its trailing slash — a bare
// reddit.com/r/GRYND costs the visitor a redirect hop.
export const REDDIT_COMMUNITY = {
  name: "Reddit",
  href: "https://www.reddit.com/r/GRYND/",
  Icon: IconBrandReddit,
};

export const SOCIAL_LINKS = [
  REDDIT_COMMUNITY,
  {
    name: "Instagram",
    href: "https://www.instagram.com/grynd.gg/",
    Icon: IconBrandInstagram,
  },
  {
    name: "TikTok",
    href: "https://www.tiktok.com/@grynd.gg",
    Icon: IconBrandTiktok,
  },
  {
    name: "YouTube",
    href: "https://www.youtube.com/@TryGrynd",
    Icon: IconBrandYoutube,
  },
  {
    name: "LinkedIn",
    href: "https://www.linkedin.com/in/grynd-gg/",
    Icon: IconBrandLinkedin,
  },
  {
    name: "X (formerly Twitter)",
    href: "https://x.com/TryGrynd",
    Icon: IconBrandX,
  },
  {
    // Product Hunt listing. Kept free of the `utm_*` tags the share button
    // appends — on our own site they'd only pad their campaign numbers.
    name: "Product Hunt",
    href: "https://www.producthunt.com/products/grynd",
    Icon: IconBrandProducthunt,
  },
];

// Tailwind needs whole class names in the source, so sizes are a lookup rather
// than an interpolated `h-${n} w-${n}` (which the compiler can't see).
const SIZES = {
  md: { tile: "h-9 w-9", icon: 18 },
  lg: { tile: "h-11 w-11", icon: 22 },
};

interface SocialLinksProps {
  /** Tile size: "md" for the footer row, "lg" for standalone cards. */
  size?: keyof typeof SIZES;
  className?: string;
  /** Test hook — each mount names its own row. */
  testId?: string;
}

export default function SocialLinks({
  size = "md",
  className = "",
  testId = "social-links",
}: SocialLinksProps) {
  const { tile, icon } = SIZES[size] ?? SIZES.md;

  return (
    <ul
      data-testid={testId}
      className={`flex flex-wrap items-center gap-2 ${className}`}
    >
      {SOCIAL_LINKS.map(({ name, href, Icon }) => (
        <li key={name}>
          {/* Icon-only, so the accessible name has to come from aria-label.
              `noopener noreferrer` keeps the opened site out of our tab. */}
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`GRYND on ${name}`}
            title={name}
            className={`flex ${tile} items-center justify-center rounded-lg border border-[#00e5ff]/25 bg-[#00e5ff]/5 text-[#7dd3fc] transition-all duration-200 hover:-translate-y-0.5 hover:border-[#00e5ff]/60 hover:text-[#f5ff3b] hover:shadow-[0_0_12px_rgba(0,229,255,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]`}
          >
            <Icon size={icon} stroke={1.8} aria-hidden="true" />
          </a>
        </li>
      ))}
    </ul>
  );
}
