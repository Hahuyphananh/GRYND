import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Rock-Paper-Scissors vs AI | GRYND",
  description:
    "Play Rock-Paper-Scissors against the AI on GRYND. Practice your reads before facing real opponents.",
};

// ?onboarding=1 (launched by the /welcome first-match step) renders the same
// Free Play vs AI game in tutorial framing: a short contextual hint, the
// one-time first-match XP bonus on completion, and a Battle Pass intro on
// the result screen. The mode is server-gated by users.first_game_completed_at,
// so replays and returning users always see plain free practice.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ onboarding?: string }>;
}) {
  const params = await searchParams;
  return <PageClient onboarding={params?.onboarding === "1"} />;
}
