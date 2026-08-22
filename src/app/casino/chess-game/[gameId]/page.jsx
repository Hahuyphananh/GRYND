import PageClient from "./PageClient";

export async function generateMetadata({ params }) {
  const { gameId } = await params;
  const shortId = gameId.length > 10 ? gameId.slice(0, 8) : gameId;
  return {
    title: `Chess Match #${shortId} — GoonBet`,
    description: `Live chess match #${shortId} on GoonBet — play out your game against another player in real time.`,
  };
}

export default function Page() {
  return <PageClient />;
}
