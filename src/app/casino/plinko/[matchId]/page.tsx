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
    title: `Plinko Match #${shortId} | GRYND`,
    description: `Live Plinko PvP match #${shortId} on GRYND. Drop your chip and out-multiply your opponent.`,
  };
}

export default function Page({ params }: { params: Promise<{ matchId: string }> }) {
  return <PageClient params={params} />;
}
