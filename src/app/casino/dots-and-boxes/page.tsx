import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Dots & Boxes — GoonBet",
  description:
    "Play Dots & Boxes on GoonBet — stake tokens and take turns drawing lines to claim the most boxes and win the pot.",
};

export default function Page() {
  return <PageClient />;
}
