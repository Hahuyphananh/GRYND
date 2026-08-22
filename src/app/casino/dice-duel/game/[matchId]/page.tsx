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
    title: `Dice Duel Match #${shortId} — GoonBet`,
    description: `Live Dice Duel match #${shortId} on GoonBet — outroll your opponent and win the wager.`,
  };
}

export default function Page() {
  return <PageClient />;
}
