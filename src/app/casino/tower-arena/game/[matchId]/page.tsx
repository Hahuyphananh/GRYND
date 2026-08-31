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
    title: `Tower Arena #${shortId} | GRYND`,
    description: `Live Tower Arena match #${shortId} on GRYND. Build the tower, avoid the collapse, and be the last player standing.`,
  };
}

export default function Page() {
  return <PageClient />;
}