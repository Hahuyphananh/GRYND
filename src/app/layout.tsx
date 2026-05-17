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
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#000000" />
      </head>

      <body className="antialiased transition-colors duration-300 bg-[#030817] text-[#d8fbff]">
        {/* 👇 SPLASH SCREEN MUST GO HERE */}
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
