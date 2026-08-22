import type { Metadata } from "next";
import NeonFlushMultiplayerPage from "../../uno/multiplayer/page";

export const metadata: Metadata = {
  title: "Neon Flush Multiplayer — GoonBet",
  description:
    "Play Neon Flush multiplayer on GoonBet — challenge other players in real-time card duels.",
};

export default function Page() {
  return <NeonFlushMultiplayerPage />;
}
