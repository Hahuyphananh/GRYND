import type { Metadata } from "next";
import PageClient from "./PageClient";

// The live match view. Not crawlable in any sense: it is a per-match client
// application behind the age-verified account gate, so it is noindex AND
// nofollow (there is nothing here to pass equity to).
export async function generateMetadata({
  params,
}: {
  params: Promise<{ matchId: string }>;
}): Promise<Metadata> {
  const { matchId } = await params;
  const shortId = matchId && matchId.length > 10 ? matchId.slice(0, 8) : matchId;
  return {
    robots: { index: false, follow: false },
    title: `Barricade Match #${shortId} | GRYND`,
    description: `Live Barricade match #${shortId} on GRYND — a free 1v1 race on a 9x9 board with ten barricades each.`,
  };
}

export default function Page() {
  return <PageClient />;
}
