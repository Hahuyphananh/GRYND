import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Rock-Paper-Scissors vs AI — GoonBet",
  description:
    "Play Rock-Paper-Scissors against the AI on GoonBet — practice your reads before facing real opponents.",
};

export default function Page() {
  return <PageClient />;
}
