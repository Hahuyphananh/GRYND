import "./globals.css";
import { Providers } from "./providers";
import ClerkSafeChatWidget from "../components/ClerkSafeChatWidget";
import DisableInspect from "../components/DisableInspect";
import CsrfFetchGuard from "../components/CsrfFetchGuard";
import TawkProvider from "../components/TawkProvider";
import SplashScreen from "../components/SplashScreen";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "GoonBet, skill-based betting platform",
  description:
    "Skilled Based gambling platform for esports and sports betting. Bet on your skills and win big with GoonBet.",
  // Explicit icon metadata so the browser tab uses our smalllogo.
  // (Next.js also auto-generates a <link rel="icon"> from
  // src/app/icon.png, but listing it here keeps the intent obvious
  // for future maintainers and covers browsers that respect the
  // metadata.icons field before scanning convention paths.)
  icons: {
    icon: [
      { url: "/icon.png", type: "image/png" },
      { url: "/images/smalllogo.png", type: "image/png" },
    ],
    apple: "/icon-192.png",
  },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" type="image/png" href="/icon.png" />
        <link rel="icon" type="image/png" href="/images/smalllogo.png" />
        <link rel="apple-touch-icon" type="image/png" href="/icon-192.png" />
        <meta name="theme-color" content="#000000" />
      </head>

      <body className="antialiased transition-colors duration-300 bg-[#030817] text-[#d8fbff]">
        {/* Skip to content — accessibility */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[9999] focus:rounded-lg focus:border focus:border-[#00e5ff] focus:bg-[#030817] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#00e5ff] focus:shadow-[0_0_20px_rgba(0,229,255,0.4)] focus:outline-none"
        >
          Skip to main content
        </a>

        {/* SPLASH SCREEN MUST GO HERE */}
        <SplashScreen />

        <Providers>
          <CsrfFetchGuard />
          <DisableInspect />
          <TawkProvider />
          <div className="pt-[68px] sm:pt-16">{children}</div>
          <ClerkSafeChatWidget />
        </Providers>
      </body>
    </html>
  );
}
