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
    title: `Tic-Tac-Toe Match #${shortId} | GRYND`,
    description: `Live Tic-Tac-Toe match #${shortId} on GRYND — a rated 1v1 duel on a 3x3 board, three in a row to win.`,
  };
}

export default function Page() {
  return <PageClient />;
}
