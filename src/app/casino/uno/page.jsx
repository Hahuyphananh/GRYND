import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata = {
  title: "Uno — GRYND",
  description:
    "Play Uno on GRYND — match colors and numbers in a fast strategic card game against the AI or other players.",
  openGraph: { images: [ogImageUrl("/images/og/neon-flush.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
