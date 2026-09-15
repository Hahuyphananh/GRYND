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
  searchParams: Promise<{ replay?: string; from?: string }>;
}) {
  const params = await searchParams;
  // ?replay=1 (from Settings → “Replay tutorial”) walks the flow again even
  // for users who already completed onboarding. Completion stays idempotent.
  const replay = params?.replay === "1";
  // ?from=questionnaire — the questionnaire just handed the player here. It
  // opts this page out of the “brand-new + unanswered → questionnaire first”
  // hand-off (see src/lib/onboardingFlow.js), which is what makes the two
  // pages impossible to loop between even if a dismissal POST fails.
  const fromQuestionnaire = params?.from === "questionnaire";

  return <PageClient replay={replay} fromQuestionnaire={fromQuestionnaire} />;
}
