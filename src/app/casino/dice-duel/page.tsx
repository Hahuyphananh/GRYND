import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Dice Duel | GRYND",
  description:
    "Play Dice Duel on GRYND. Turn-based 1v1 dice combat. Outroll your rival and claim the pot.",
};

export default function Page() {
  return <PageClient />;
}
