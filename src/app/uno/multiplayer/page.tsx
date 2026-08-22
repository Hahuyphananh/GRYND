import type { Metadata } from "next";
import UnoMultiplayerPage from "../../casino/uno/multiplayer/page";

export const metadata: Metadata = {
  title: "Uno Multiplayer — GoonBet",
  description:
    "Play Uno multiplayer on GoonBet — challenge other players in real-time card duels.",
};

export default function Page() {
  return <UnoMultiplayerPage />;
}
