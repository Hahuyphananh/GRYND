import PageClient from "./PageClient";

export async function generateMetadata({ params }) {
  const { matchId } = await params;
  const shortId = matchId.length > 10 ? matchId.slice(0, 8) : matchId;
  return {
    robots: { index: false, follow: false },
    title: `Lane Rush Match #${shortId} | GRYND`,
    description: `Live Lane Rush race #${shortId} on GRYND. Both players plan a secret grid, then race the same oval — first to 1,000 points takes the match.`,
  };
}

export default function Page({ params }) {
  return <PageClient params={params} />;
}
