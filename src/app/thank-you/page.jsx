import PageClient from "./PageClient";
import { ogImageUrl } from "../../lib/ogImages";

export const metadata = {
  robots: { index: false, follow: false },

  title: "Welcome to GRYND!",
  description:
    "Your GRYND account is ready and your free tokens are waiting. Pick a skill-based game and start playing.",
  openGraph: {
    title: "Welcome to GRYND!",
    description: "Your GRYND account is ready and your free tokens are waiting.",
    url: ogImageUrl("/thank-you"),
    siteName: "GRYND",
    locale: "en_US",
    images: [{ url: ogImageUrl("/images/og-banner.png"), width: 1200, height: 630, alt: "GRYND" }],
    type: "website",
  },
  // Next.js replaces the layout's twitter block wholesale, so it is restated
  // here rather than inherited (see scripts/audit-social-metadata.mjs).
  twitter: {
    card: "summary_large_image",
    title: "Welcome to GRYND!",
    description: "Your GRYND account is ready and your free tokens are waiting.",
    images: [ogImageUrl("/images/og-banner.png")],
  },
};

export default function Page() {
  return <PageClient />;
}
