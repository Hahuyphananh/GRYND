import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Precision — GRYND",
  description:
    "Play Precision on GRYND — wager tokens and face another player in a 1v1 reaction-time duel. Test your reflexes and win the pot.",
};

export default function Page() {
  return <PageClient />;
}
