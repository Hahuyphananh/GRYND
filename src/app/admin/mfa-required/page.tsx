import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import PageClient from "./PageClient";
import {
  ADMIN_MFA_COOKIE,
  USER_MFA_COOKIE,
  verifyAdminMfaToken,
  verifyUserMfaToken,
} from "../../../lib/auth/adminMfa";
import { hasRecentMfa } from "../../../lib/auth/requireMfa";

export const metadata: Metadata = {
  robots: { index: false, follow: false },

  title: "Two-Factor Authentication | GRYND",
  description:
    "Complete two-factor authentication to access the GRYND admin dashboard.",
};

export default async function Page() {
  // The step-up is asked once per session: if this session already holds a
  // valid second factor, the gate page must not be shown again — e.g. via a
  // bookmark, the back button, or a restored tab. Send them to the dashboard.
  //
  // `/admin` re-checks the same condition, so this can never become a bounce
  // loop: a session without a valid factor is redirected back here by the
  // middleware before that page renders.
  const { userId, factorVerificationAge } = await auth();
  if (userId) {
    const jar = await cookies();
    const satisfied =
      hasRecentMfa(factorVerificationAge) ||
      (await verifyAdminMfaToken(jar.get(ADMIN_MFA_COOKIE)?.value, userId)) ||
      (await verifyUserMfaToken(jar.get(USER_MFA_COOKIE)?.value, userId));
    if (satisfied) redirect("/admin");
  }

  return <PageClient />;
}
