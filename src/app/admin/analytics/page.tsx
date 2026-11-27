// src/app/admin/analytics/page.tsx
//
// Solitaire analytics dashboard. Admin-only, and read-only: it renders the
// volumes PostHog already holds for the taxonomy in src/lib/solitaire-analytics.
// No event can be created, edited or deleted from here.

import type { Metadata } from "next";

import { requireAdminPage } from "../../../lib/admin/requireAdminPage";
import AnalyticsDashboardClient from "./AnalyticsDashboardClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Solitaire analytics | GRYND Admin",
  description: "Read-only Solitaire event volumes from PostHog.",
};

export default async function AdminAnalyticsPage() {
  await requireAdminPage();
  return <AnalyticsDashboardClient />;
}
