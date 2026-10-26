import { requireAdminPage } from "../../lib/admin/requireAdminPage";
import AdminDashboardClient from "./AdminDashboardClient";
import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },

  title: "Admin Dashboard | GRYND",
  description:
    "GRYND admin dashboard for platform management, monitoring and operations.",
};

export default async function AdminPage() {
  // Authentication → authorisation → second factor, re-checked here even though
  // the middleware enforces the same rules for /admin/*.
  await requireAdminPage();

  return <AdminDashboardClient initialAdminVerified />;
}
