import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Odds — GoonBet",
  description:
    "Play Odds on GoonBet — pick a hidden number, then predict the opponent's. Closest predictions earn points as the range shrinks from 100 to 3.",
};

export default function Page() {
  return <PageClient />;
}
