import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Dice Duel — GoonBet",
  description:
    "Play Dice Duel on GoonBet — turn-based 1v1 dice combat. Outroll your rival and claim the pot.",
};

export default function Page() {
  return <PageClient />;
}
