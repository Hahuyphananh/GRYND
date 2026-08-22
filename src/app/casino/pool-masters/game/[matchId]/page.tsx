import type { Metadata } from "next";
import PageClient from "./PageClient";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ matchId: string }>;
}): Promise<Metadata> {
  const { matchId } = await params;
  const shortId = matchId.length > 10 ? matchId.slice(0, 8) : matchId;
  return {
    title: `Pool Masters Match #${shortId} — GRYND`,
    description: `Live Pool Masters match #${shortId} on GRYND — sink the 8-ball before your opponent to win the wager.`,
  };
}

export default function Page() {
  return <PageClient />;
}
