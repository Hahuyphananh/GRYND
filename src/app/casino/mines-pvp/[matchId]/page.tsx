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
    title: `Mines Duel Match #${shortId} | GRYND`,
    description: `Live Mines Duel match #${shortId} on GRYND. Two players race their own 10×10 minefields on one shared clock — reveal, flag and score the most before time runs out.`,
  };
}

export default function Page({ params }: { params: Promise<{ matchId: string }> }) {
  return <PageClient params={params} />;
}
