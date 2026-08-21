import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isAdmin } from "../../lib/auth/isAdmin";
import { hasRecentMfa } from "../../lib/auth/requireMfa";
import AdminDashboardClient from "./AdminDashboardClient";

export default async function AdminPage() {
  const { userId, factorVerificationAge } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  if (!(await isAdmin(userId))) {
    redirect("/");
  }

  // Admin access requires a recent second factor (MFA) — defense in depth
  // on top of the middleware check.
  if (!hasRecentMfa(factorVerificationAge)) {
    redirect("/admin/mfa-required");
  }

  return <AdminDashboardClient initialAdminVerified />;
}
