import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Hex Duel Multiplayer — GRYND",
  description:
    "Play Hex Duel multiplayer on GRYND — face other players in real-time hex-grid duels.",
};

export default function Page() {
  return <PageClient />;
}
