import Link from "next/link";
import NavigationBar from "../../components/navigation-bar";
import Footer from "../../components/Footer";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

/**
 * /account-deletion — the public account-deletion page Google Play requires.
 *
 * WHY THIS PAGE EXISTS
 * Google Play's Data deletion policy requires every app that lets users create
 * an account to provide a URL, reachable WITHOUT signing in, that explains how
 * to request deletion. The in-app path (Profile → Danger zone → Delete account,
 * backed by POST /api/delete-account) satisfies the product requirement but not
 * the policy one: a reviewer, or someone who can no longer sign in, cannot reach
 * a route behind an auth wall.
 *
 * Everything stated below is taken from the code, not from intent:
 *   - src/app/api/delete-account/route.js erases the Clerk account first, then
 *   - src/lib/security/deleteUserData.ts purges the local rows, keeping only
 *     reports filed AGAINST the user (anonymised), audit logs (legal
 *     retention) and the hashed rating identity (anti-reset, no direct PII).
 * The immediate/no-waiting-period wording matches the privacy policy, which
 * /privacy-policy already publishes.
 *
 * It is a static server component with no ad code and no client-side script,
 * and it is footer-linked so it is reachable from anywhere on the site.
 */

export const metadata = pageMetadata({
  title: "Delete your account",
  description:
    "How to delete your GRYND account and its data, in the app or on the web, what is erased immediately, and the limited records we must keep.",
  path: "/account-deletion",
  image: DEFAULT_OG_IMAGE,
});

const H2 = "text-xl font-black tracking-tight text-[color:var(--text-primary)] sm:text-2xl";
const P = "mt-3 leading-relaxed text-[color:var(--text-secondary)]";
const LIST = "mt-3 list-disc space-y-2 pl-5 leading-relaxed text-[color:var(--text-secondary)]";
const STEPS = "mt-3 list-decimal space-y-2 pl-5 leading-relaxed text-[color:var(--text-secondary)]";
const LINK =
  "text-[color:var(--text-primary)] underline underline-offset-2 hover:text-[color:var(--accent-strong)]";

export default function AccountDeletionPage() {
  return (
    <div className="relative min-h-dvh overflow-x-clip pb-16">
      <NavigationBar currentPath="/account-deletion" />

      <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
        <nav aria-label="Breadcrumb" className="mb-6 text-xs text-[color:var(--text-muted)]">
          <ol className="flex flex-wrap items-center gap-2">
            <li>
              <Link
                href="/"
                className="underline underline-offset-2 hover:text-[color:var(--text-primary)]"
              >
                Home
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-[color:var(--text-secondary)]">
              Delete your account
            </li>
          </ol>
        </nav>

        <header>
          <h1 className="text-3xl font-black leading-tight tracking-tight text-[color:var(--text-primary)] sm:text-4xl">
            Delete your GRYND account
          </h1>
          <p className={P}>
            This page explains how to delete your account and the data attached to it. It applies to
            the <strong>GRYND</strong> app on Google Play and to the GRYND website, and you can read
            it without signing in.
          </p>
        </header>

        <section className="mt-10" aria-labelledby="how">
          <h2 id="how" className={H2}>
            Delete it yourself, in the app
          </h2>
          <p className={P}>
            If you can still sign in, you do not need to contact us — deletion is self-serve and
            takes effect immediately.
          </p>
          <ol className={STEPS}>
            <li>Open GRYND and go to your Profile.</li>
            <li>Scroll to the Danger zone section.</li>
            <li>
              Choose <strong>Delete account</strong> and enter your password to confirm. The
              password check is what stops someone else deleting your account from a device you left
              signed in.
            </li>
            <li>The account and its data are erased right away, and you are signed out.</li>
          </ol>
          <p className={P}>
            There is no waiting period and no way to undo it. Once the account is gone it cannot be
            restored, and a new account starts from zero.
          </p>
        </section>

        <section className="mt-10" aria-labelledby="locked-out">
          <h2 id="locked-out" className={H2}>
            If you cannot sign in
          </h2>
          <p className={P}>
            Use the{" "}
            <Link href="/contact" className={LINK}>
              contact form
            </Link>{" "}
            from the email address on the account. Tell us you want the account deleted. We confirm
            you own the address, delete the account, and reply to confirm — within 30 days, and
            usually much sooner. If you have lost access to that mailbox, say so in the message and
            we will tell you what else we can accept as proof of ownership.
          </p>
        </section>

        <section className="mt-10" aria-labelledby="removed">
          <h2 id="removed" className={H2}>
            What deletion removes
          </h2>
          <ul className={LIST}>
            <li>Your account and sign-in identity: email address, password, display name.</li>
            <li>
              Your profile: picture, title, level, streaks, statistics and ladder rating for every
              game.
            </li>
            <li>
              Your game history: solo results and daily puzzles, and every PvP match you played in,
              as either player.
            </li>
            <li>
              Content you created: chat messages, reviews, and any player report you filed — the
              text of a complaint is yours.
            </li>
            <li>Your coin balance, inventory and login-reward streak.</li>
            <li>The purchase and checkout records tied to your account.</li>
          </ul>
        </section>

        <section className="mt-10" aria-labelledby="kept">
          <h2 id="kept" className={H2}>
            What we keep, and why
          </h2>
          <p className={P}>
            Deletion is not quite total, and it is fairer to say so plainly than to let you assume
            otherwise. Three things survive:
          </p>
          <ul className={LIST}>
            <li>
              <strong>Reports other players filed about you.</strong> The report stays as moderation
              evidence — another player&apos;s complaint should not vanish because the reported
              account was deleted — but your identity is removed from it and replaced with a
              placeholder.
            </li>
            <li>
              <strong>Security and compliance audit logs.</strong> These are retained as required by
              law and are not tied to a profile you can see.
            </li>
            <li>
              <strong>A one-way hash derived from your email address.</strong> It exists so a
              deleted-and-recreated account cannot reset its ladder rating or restart its
              provisional match window. It contains no directly identifying data, and it cannot be
              used to sign in or to contact you.
            </li>
          </ul>
          <p className={P}>
            Backup copies of the database may also persist for a limited period before being
            overwritten in the normal backup cycle.
          </p>
        </section>

        <section className="mt-10" aria-labelledby="before">
          <h2 id="before" className={H2}>
            Before you delete
          </h2>
          <ul className={LIST}>
            <li>
              <strong>Coins and purchases are not refundable.</strong> Deleting the account forfeits
              your coin balance and anything you bought with it, as described in the Terms of
              Service.
            </li>
            <li>
              <strong>Cancel an active GRYND PRO subscription first.</strong> Account deletion
              removes your GRYND account; it does not by itself stop a subscription that is already
              billing. Cancel from the GRYND PRO page before you delete, so you are not charged
              again.
            </li>
            <li>
              <strong>Deletion is permanent.</strong> Game history, statistics and titles cannot be
              recovered afterwards.
            </li>
          </ul>
        </section>

        <section className="mt-10" aria-labelledby="questions">
          <h2 id="questions" className={H2}>
            Questions
          </h2>
          <p className={P}>
            For what we collect and how long we keep it, see the{" "}
            <Link href="/privacy-policy" className={LINK}>
              privacy policy
            </Link>
            . For anything else — including a deletion request if you cannot sign in — use the{" "}
            <Link href="/contact" className={LINK}>
              contact form
            </Link>
            , or check the{" "}
            <Link href="/faq" className={LINK}>
              FAQ
            </Link>
            .
          </p>
        </section>

        <p className="mt-10 text-xs text-[color:var(--text-muted)]">
          Last updated: 19 November 2026.
        </p>
      </div>

      <Footer />
    </div>
  );
}
