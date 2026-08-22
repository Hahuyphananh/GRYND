import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Pool Masters — GoonBet",
  description:
    "Play Pool Masters on GoonBet — a strategic 1v1 game of pool. Wager tokens, sink the 8-ball and win the pot.",
};

export default function Page() {
  return <PageClient />;
}
