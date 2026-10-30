import PageClient from "./PageClient";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  const { matchId } = await params;
  const short = matchId.length > 8 ? matchId.slice(0, 8) : matchId;
  return {
    robots: { index: false, follow: false },
    title: `LAST RUN · Match ${short} | GRYND`,
    description: "A live 1v1 LAST RUN — two runners, one seeded course, first crash loses.",
  };
}

export default async function Page({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  const { matchId } = await params;
  return <PageClient matchId={matchId} />;
}
