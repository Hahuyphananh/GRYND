import type { Metadata } from "next";

import MatchClient from "./MatchClient";

export async function generateMetadata({ params }: { params: Promise<{ matchId: string }> }): Promise<Metadata> {
  const { matchId } = await params;
  const short = matchId.length > 8 ? matchId.slice(0, 8) : matchId;
  return {
    title: `LAST RUN · Match ${short} | GRYND`,
    description: "A live 1v1 LAST RUN — two runners, one seeded course, first crash loses.",
    robots: { index: false, follow: false },
  };
}

export default async function LastRunMatchPage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  return <MatchClient matchId={matchId} />;
}
