import PageClient from "./PageClient";

export async function generateMetadata({ params }) {
  const { tableId } = await params;
  const shortId = tableId.length > 10 ? tableId.slice(0, 8) : tableId;
  return {
    title: `Crash Arena Table #${shortId} | GRYND`,
    description: `Live Crash Arena table #${shortId} on GRYND. Cash out before the crash and claim the pot.`,
  };
}

export default function Page() {
  return <PageClient />;
}
