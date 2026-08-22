import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Hex Duel Multiplayer — GoonBet",
  description:
    "Play Hex Duel multiplayer on GoonBet — face other players in real-time hex-grid duels.",
};

export default function Page() {
  return <PageClient />;
}
