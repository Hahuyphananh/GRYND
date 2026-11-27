// src/app/admin/analytics/solitaire/page.tsx
//
// Product & retention dashboard. Admin-gated server component; all data is
// fetched from /api/admin/analytics/solitaire, which re-checks authorisation.

import type { Metadata } from "next";

import { requireAdminPage } from "../../../../lib/admin/requireAdminPage";
import ProductDashboardClient from "./ProductDashboardClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Solitaire product metrics | GRYND Admin",
  description: "Activation, retention, gameplay, matchmaking and review metrics.",
};

export default async function SolitaireProductPage() {
  await requireAdminPage();
  return <ProductDashboardClient />;
}
