import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Personalize your GRYND | GRYND",
  description:
    "Tell us what kind of games you like and GRYND will personalize your experience. Five quick questions, under a minute.",
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const params = await searchParams;
  // ?from=welcome|lobby|settings — where the flow was opened from. It only
  // decides the post-submit destination (see questionnaireDestination in
  // src/lib/onboardingFlow.js); completion is always the same
  // server-authoritative questionnaire flag.
  const from =
    params?.from === "welcome" ||
    params?.from === "lobby" ||
    params?.from === "settings"
      ? params.from
      : undefined;

  return <PageClient from={from} />;
}
