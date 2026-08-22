import type { Metadata } from "next";
import PageClient from "./PageClient";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ gameId: string }>;
}): Promise<Metadata> {
  const { gameId } = await params;
  const shortId = gameId.length > 10 ? gameId.slice(0, 8) : gameId;
  return {
    title: `Rock-Paper-Scissors Match #${shortId} — GoonBet`,
    description: `Live Rock-Paper-Scissors match #${shortId} on GoonBet — first to 4 rounds takes the pot.`,
  };
}

export default function Page() {
  return <PageClient />;
}
