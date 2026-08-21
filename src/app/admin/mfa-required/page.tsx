import Link from "next/link";
import InteractiveCasinoBg from "../../../components/InteractiveCasinoBg";

// Clerk's hosted Account Portal — where users enable MFA in their security
// settings. Computed from the publishable key, which embeds the instance
// domain base64-encoded: pk_test_<base64("instance.clerk.accounts.dev")>.
function getAccountPortalUrl(): string {
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "";
  const instance = key.split("_")[2];
  if (!instance) {
    return "https://clerk.com/docs/security/multi-factor-authentication";
  }
  try {
    const decoded = Buffer.from(instance, "base64").toString("utf8");
    if (decoded.includes(".")) return `https://${decoded}/user`;
  } catch {
    // fall through to the raw-instance fallback below
  }
  return `https://${instance}/user`;
}

export default function AdminMfaRequiredPage() {
  const accountPortalUrl = getAccountPortalUrl();

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-16">
      <InteractiveCasinoBg variant="subtle" />
      <div className="relative z-10 w-full max-w-lg rounded-2xl border border-[#f5ff3b]/30 bg-[#040d24]/90 p-8 shadow-[0_0_40px_rgba(245,255,59,0.15)] backdrop-blur-md">
        <h1 className="mb-3 text-2xl font-extrabold text-[#f5ff3b]">
          Multi-Factor Authentication Required
        </h1>
        <p className="mb-4 leading-relaxed text-[#c9f7ff]/90">
          Admin access to GoonBet requires a recent multi-factor authentication
          (MFA) step. This session has not verified a second factor, so the
          admin dashboard is locked.
        </p>
        <ol className="mb-6 list-decimal space-y-2 pl-5 text-sm text-[#c9f7ff]/80">
          <li>
            Enable MFA in your Clerk account security settings (button below).
          </li>
          <li>
            Sign out, then sign back in — the new session will carry your MFA
            verification.
          </li>
          <li>Return to the admin dashboard.</li>
        </ol>
        <div className="flex flex-col gap-3 sm:flex-row">
          <a
            href={accountPortalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-[#f5ff3b]/50 bg-gradient-to-r from-[#ffd700] via-[#f5ff3b] to-[#ffb800] px-5 py-2.5 text-center text-sm font-bold text-[#1f1700] shadow-[0_0_18px_rgba(245,255,59,0.4)] transition-all hover:shadow-[0_0_26px_rgba(245,255,59,0.65)]"
          >
            Enable MFA in my account
          </a>
          <a
            href="/sign-in"
            className="rounded-lg border border-[#00e5ff]/40 px-5 py-2.5 text-center text-sm font-semibold text-[#d8fbff] transition-all hover:border-[#00e5ff]/70 hover:bg-[#00e5ff]/10"
          >
            Sign in again
          </a>
          <Link
            href="/"
            className="rounded-lg border border-[#00e5ff]/40 px-5 py-2.5 text-center text-sm font-semibold text-[#d8fbff] transition-all hover:border-[#00e5ff]/70 hover:bg-[#00e5ff]/10"
          >
            Back to home
          </Link>
        </div>
        <p className="mt-6 text-xs text-[#9dd8ff]/70">
          MFA must be completed within the last 24 hours to unlock the admin
          dashboard. Contact the platform owner if you believe this is a
          mistake.
        </p>
      </div>
    </div>
  );
}
