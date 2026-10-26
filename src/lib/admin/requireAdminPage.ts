// src/lib/admin/requireAdminPage.ts
//
// The page-level half of the admin gate: defense in depth.
//
// The middleware (src/proxy.ts) already enforces admin role + MFA for /admin/*;
// this re-checks in the page component so a middleware regression cannot expose
// an admin surface on its own. Admin access requires a recent second factor,
// satisfied by either Clerk's native MFA or our signed admin_mfa cookie.
//
// Every admin page calls this, so the check exists once and cannot drift
// between pages.
//
// Order matters: authentication, then authorisation, then second factor. Each
// redirect carries no information about the others.

import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ADMIN_MFA_COOKIE, verifyAdminMfaToken } from "../auth/adminMfa";
import { isAdmin } from "../auth/isAdmin";
import { hasRecentMfa } from "../auth/requireMfa";

export async function requireAdminPage(): Promise<{ userId: string }> {
  const { userId, factorVerificationAge } = await auth();

  if (!userId) redirect("/sign-in");
  if (!(await isAdmin(userId))) redirect("/");

  const token = (await cookies()).get(ADMIN_MFA_COOKIE)?.value;
  if (!hasRecentMfa(factorVerificationAge) && !(await verifyAdminMfaToken(token, userId))) {
    redirect("/admin/mfa-required");
  }

  return { userId };
}
