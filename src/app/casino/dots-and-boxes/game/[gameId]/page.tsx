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
    title: `Dots & Boxes Match #${shortId} | GRYND`,
    description: `Live Dots & Boxes match #${shortId} on GRYND. Claim more boxes than your opponent to win the pot.`,
  };
}

export default function Page() {
  return <PageClient />;
}
