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
    title: `Blackjack PvP Match #${shortId} — GRYND`,
    description: `Live Blackjack PvP match #${shortId} on GRYND — best-of-3 rounds, head-to-head. Freeze, swap and peek your way to the pot.`,
  };
}

export default function Page({ params }: { params: Promise<{ matchId: string }> }) {
  return <PageClient params={params} />;
}
