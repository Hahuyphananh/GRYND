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
    title: `Four-In-A-Row Match #${shortId} | GRYND`,
    description: `Live Four-In-A-Row match #${shortId} on GRYND. Align four discs to beat your opponent and win the pot.`,
  };
}

export default function Page() {
  return <PageClient />;
}
