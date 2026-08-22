import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isAdmin } from "../../lib/auth/isAdmin";
import { hasRecentMfa } from "../../lib/auth/requireMfa";
import { ADMIN_MFA_COOKIE, verifyAdminMfaToken } from "../../lib/auth/adminMfa";
import AdminDashboardClient from "./AdminDashboardClient";

export default async function AdminPage() {
  const { userId, factorVerificationAge } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  if (!(await isAdmin(userId))) {
    redirect("/");
  }

  // Admin access requires a recent second factor — defense in depth on top of
  // the middleware check. Accepts either Clerk's native MFA or our self-hosted
  // signed cookie (email code / authenticator app / passphrase).
  const adminMfaToken = (await cookies()).get(ADMIN_MFA_COOKIE)?.value;
  if (
    !hasRecentMfa(factorVerificationAge) &&
    !(await verifyAdminMfaToken(adminMfaToken, userId))
  ) {
    redirect("/admin/mfa-required");
  }

  return <AdminDashboardClient initialAdminVerified />;
}
