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
    title: `Mini Golf Match #${shortId} | GRYND`,
    description: `Live Mini Golf match #${shortId} on GRYND — best of 5 holes, first to 3 hole wins.`,
  };
}

export default function Page() {
  return <PageClient />;
}
