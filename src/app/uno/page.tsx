import type { Metadata } from "next";
import UnoGamePage from "../casino/uno/page";

export const metadata: Metadata = {
  title: "Uno — GoonBet",
  description:
    "Play Uno on GoonBet — match colors and numbers in a fast strategic card game against the AI or other players.",
};

export default function Page() {
  return <UnoGamePage />;
}
