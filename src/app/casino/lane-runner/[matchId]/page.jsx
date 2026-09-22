import PageClient from "./PageClient";

export async function generateMetadata({ params }) {
  const { matchId } = await params;
  const shortId = matchId.length > 10 ? matchId.slice(0, 8) : matchId;
  return {
    title: `Lane Rush Duel Match #${shortId} | GRYND`,
    description: `Live Lane Rush Duel match #${shortId} on GRYND. Both players cross the same 10-row bridge — beat your opponent to claim the pot.`,
  };
}

export default function Page({ params }) {
  return <PageClient params={params} />;
}
