import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Hex Duel History — GoonBet",
  description: "Review your Hex Duel match history on GoonBet.",
};

export default function Page() {
  return <PageClient />;
}
