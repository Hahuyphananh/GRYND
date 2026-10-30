import type { Metadata } from "next";

import LobbyClient from "./LobbyClient";

const title = "LAST RUN | GRYND";
const description =
  "LAST RUN is GRYND's 1v1 endless-runner duel: both players run the same seeded course, and the first crash loses. Jump with Space or Arrow Up, duck with Arrow Down.";

// This page is a new, unreleased game surface: it is deliberately noindex until
// it has a public landing page and a catalogue entry, so it cannot compete with
// the game pages that already carry GRYND's SEO.
export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/games/last-run" },
  robots: { index: false, follow: false },
  openGraph: { title, description, siteName: "GRYND", type: "website" },
};

export default async function LastRunLobbyPage({
  searchParams,
}: {
  searchParams: Promise<{ queue?: string }>;
}) {
  const params = await searchParams;
  return <LobbyClient autoQueue={params?.queue === "1"} />;
}
