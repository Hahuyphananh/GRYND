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
    title: `Precision Match #${shortId} — GoonBet`,
    description: `Live Precision match #${shortId} on GoonBet — race your reaction time against your opponent across multiple rounds.`,
  };
}

export default function Page({ params }: { params: Promise<{ matchId: string }> }) {
  return <PageClient params={params} />;
}
