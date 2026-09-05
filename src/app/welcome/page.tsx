import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Welcome to Grynd | GRYND",
  description:
    "Welcome to GRYND — the competitive PvP skill-gaming platform. Learn how tokens, PvP matches and the Battle Pass work before you jump in.",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ replay?: string }>;
}) {
  const params = await searchParams;
  // ?replay=1 (from Settings → “Replay tutorial”) walks the flow again even
  // for users who already completed onboarding. Completion stays idempotent.
  const replay = params?.replay === "1";

  return <PageClient replay={replay} />;
}
