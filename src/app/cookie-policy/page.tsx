import type { Metadata } from "next";
import Link from "next/link";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import CookieSettingsLink from "../../components/CookieSettingsLink";

/**
 * /cookie-policy — the cookie and advertising disclosure, on its own URL.
 *
 * WHY A SEPARATE PAGE
 * The privacy policy answers "what personal data do you collect"; a site review
 * additionally wants one page that names every cookie class, states what the
 * advertising cookies are for, and gives a working opt-out for personalised
 * advertising. Google's EU user consent policy requires exactly that
 * disclosure and opt-out for visitors in the EEA, the UK and Switzerland, and
 * AdSense's own review checks it for everyone. Burying it as a section of a
 * long privacy policy makes it hard to find and hard to verify.
 *
 * The withdrawal route is the SAME control the banner uses
 * (components/CookieSettingsLink.tsx → COOKIE_CONSENT_EVENT), so the page can
 * never describe a control that does not exist.
 *
 * NO AD SLOT AND NO AD LOADER: a policy page is not a content page, and ads on
 * it would be inventory with nothing behind it.
 */

export const metadata: Metadata = {
  title: "Cookie Policy | GRYND",
  description:
    "Every cookie and storage class GRYND uses, what Google AdSense sets for advertising, how personalised advertising is controlled, and how to withdraw consent at any time.",
  alternates: { canonical: "/cookie-policy" },
};

const H2 = "text-xl font-black tracking-tight text-[#f5ff3b] sm:text-2xl";
const H3 = "mt-6 text-base font-bold text-[#d8fbff]";
const P = "mt-3 leading-relaxed text-[#d8fbff]";
const LIST = "mt-3 list-disc space-y-2 pl-5 leading-relaxed text-[#d8fbff]";
const LINK = "text-[#00e5ff] underline underline-offset-2 hover:text-[#f5ff3b]";

export default function CookiePolicyPage() {
  return (
    <div className="relative min-h-screen overflow-x-clip pb-16">
      <NavigationBar currentPath="/cookie-policy" />

      <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        <nav aria-label="Breadcrumb" className="mb-6 text-xs text-[#9dd8ff]">
          <ol className="flex flex-wrap items-center gap-2">
            <li>
              <Link href="/" className="underline underline-offset-2 hover:text-[#d8fbff]">
                Home
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-[#d8fbff]">
              Cookie Policy
            </li>
          </ol>
        </nav>

        <header>
          <h1 className="text-3xl font-black leading-tight tracking-tight text-[#f5ff3b] sm:text-4xl">
            Cookie Policy
          </h1>
          <p className="mt-4 leading-relaxed text-[#d8fbff]">
            This page lists every cookie and local-storage entry GRYND uses, says which of them
            are essential, and explains what the advertising cookies are for and how to turn
            personalised advertising off. It covers cookies set by us and by the third parties
            listed below.
          </p>
        </header>

        <section className="mt-10" aria-labelledby="categories">
          <h2 id="categories" className={H2}>
            The four classes we use
          </h2>

          <h3 className={H3}>1. Strictly necessary</h3>
          <p className={P}>
            These make the site work and cannot be switched off from the banner. They include the
            Clerk authentication and session cookies that keep you signed in, a short-lived
            CSRF-protection value used to validate form and API requests, and — for administrators
            only — a 24-hour security cookie used for the admin second-factor check. Without them
            you cannot sign in or play.
          </p>

          <h3 className={H3}>2. Preferences</h3>
          <p className={P}>
            Stored in your browser (localStorage) rather than sent to us: your theme, language,
            audio settings, onboarding-tour progress, your cookie-consent choice, and a temporary
            game-session identifier used by some games so a refresh does not drop a match.
          </p>

          <h3 className={H3}>3. Analytics and diagnostics</h3>
          <p className={P}>
            Google Analytics 4, PostHog and Sentry measure how the product is used and report
            errors. They are loaded <strong>only after you accept</strong>. If you decline, the
            tags are not loaded, and nothing about your visit is sent to them from the browser.
          </p>

          <h3 className={H3}>4. Advertising</h3>
          <p className={P}>
            Advertising is served by <strong>Google AdSense</strong>. Google and its advertising
            partners may set cookies on your device, or read device identifiers, in order to serve
            ads, measure them, limit how often you see the same ad, and — where you have consented
            — personalise them. Google may use the DoubleClick/Google Advertising Products cookie
            for this purpose. These cookies are not set by GRYND and their content is not visible
            to us.
          </p>
          <p className={P}>
            Where consent applies, our four Google Consent Mode signals (ad storage, ad user data,
            ad personalisation, analytics storage) start <em>denied</em> before any tag runs. Until
            a consent source records a choice, ad requests carry no advertising cookie and no
            personalisation, and ad click identifiers are redacted.
          </p>
          <p className={P}>
            Visitors in the European Economic Area, the United Kingdom and Switzerland are shown a
            consent message from Google’s certified consent management platform, which lets them
            refuse as easily as accept. Visitors elsewhere are shown GRYND’s own banner. Only one
            of the two prompts is ever shown, so there are never two disagreeing consent records.
          </p>
        </section>

        <section className="mt-10" aria-labelledby="where">
          <h2 id="where" className={H2}>
            Where ads can and cannot appear
          </h2>
          <p className={P}>
            Ads appear only on browsing pages: the home page, the game hub, the leaderboard, the
            profile page, the game lobbies and the guides. Every block is labelled
            “Advertisement”. There is no ad code on a live board or a match page, so advertising
            can never interrupt, cover or shift a game in progress. GRYND PRO members receive no
            ad code and make no ad requests.
          </p>
        </section>

        <section className="mt-10" aria-labelledby="choices">
          <h2 id="choices" className={H2}>
            How to change or withdraw your choice
          </h2>
          <p className={P}>
            Withdrawing is as easy as consenting: the{" "}
            <CookieSettingsLink className={LINK} /> link in the footer of every page reopens the
            choices and records a new decision immediately.
          </p>
          <p className={P}>
            You can also control personalised advertising directly with the advertising industry’s
            own tools. Opting out of personalisation does not remove ads; it makes them
            non-personalised:
          </p>
          <ul className={LIST}>
            <li>
              <a
                href="https://adssettings.google.com"
                target="_blank"
                rel="noopener noreferrer nofollow"
                className={LINK}
              >
                Google Ads Settings
              </a>{" "}
              — turn off personalised ads from Google, and see what Google holds for your account.
            </li>
            <li>
              <a
                href="https://www.aboutads.info/choices/"
                target="_blank"
                rel="noopener noreferrer nofollow"
                className={LINK}
              >
                Digital Advertising Alliance opt-out
              </a>{" "}
              — one place to opt out of interest-based advertising from participating companies.
            </li>
            <li>
              <a
                href="https://optout.networkingadvertising.org/"
                target="_blank"
                rel="noopener noreferrer nofollow"
                className={LINK}
              >
                Network Advertising Initiative opt-out
              </a>{" "}
              — the equivalent tool for NAI members.
            </li>
            <li>
              Your browser’s own settings can block or delete cookies and local storage. Blocking
              essential cookies will stop you signing in; blocking advertising cookies does not
              affect gameplay.
            </li>
          </ul>
        </section>

        <section className="mt-10" aria-labelledby="sale">
          <h2 id="sale" className={H2}>
            We do not sell your personal information
          </h2>
          <p className={P}>
            GRYND does not sell personal information, and does not share it for cross-context
            behavioural advertising beyond the consent you have given to the advertising partners
            described above. Your consent choice is stored on your device, and you can clear it by
            clearing site data.
          </p>
          <p className={P}>
            For what we collect beyond cookies, how long it is kept and how to exercise your
            access, correction and deletion rights, see the{" "}
            <Link href="/privacy-policy" className={LINK}>
              privacy policy
            </Link>
            . Questions can go through the{" "}
            <Link href="/contact" className={LINK}>
              contact form
            </Link>
            .
          </p>
        </section>

        <p className="mt-10 text-xs text-[#9dd8ff]/70">Last updated: 15 November 2026.</p>
      </div>

      <Footer />
    </div>
  );
}
