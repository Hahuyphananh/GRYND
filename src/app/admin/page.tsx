import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isAdmin } from "../../lib/auth/isAdmin";
import AdminDashboardClient from "./AdminDashboardClient";

export default async function AdminPage() {
  const { userId } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  if (!(await isAdmin(userId))) {
    redirect("/");
  }

  return <AdminDashboardClient initialAdminVerified />;
}
