import PageClient from "./PageClient";

export async function generateMetadata({ params }) {
  const { matchId } = await params;
  const shortId = matchId.length > 10 ? matchId.slice(0, 8) : matchId;
  return {
    title: `Keno Duel Match #${shortId} — GRYND`,
    description: `Live 1v1 Keno Duel #${shortId} on GRYND — out-catch your opponent across a best-of-5 match.`,
  };
}

export default function Page({ params }) {
  return <PageClient params={params} />;
}
