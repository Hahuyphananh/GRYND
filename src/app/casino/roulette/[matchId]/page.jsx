import PageClient from "./PageClient";

export async function generateMetadata({ params }) {
  const { matchId } = await params;
  const shortId = matchId.length > 10 ? matchId.slice(0, 8) : matchId;
  return {
    title: `Roulette Match #${shortId} — GoonBet`,
    description: `Live Roulette PvP match #${shortId} on GoonBet — spin the wheel and beat your opponent to the pot.`,
  };
}

export default function Page({ params }) {
  return <PageClient params={params} />;
}
