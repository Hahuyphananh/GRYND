import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../../components/AdSenseScript";
import MonetagScript from "../../../../components/MonetagScript";

export const metadata: Metadata = {
  title: "Hex Duel Multiplayer | GRYND",
  description:
    "Play Hex Duel multiplayer on GRYND. Face other players in real-time hex-grid duels.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <MonetagScript />
      <PageClient />
    </>
  );
}
