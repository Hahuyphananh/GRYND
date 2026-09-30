import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata: Metadata = {
  title: "Solitaire Duel | GRYND",
  description:
    "Play Solitaire Duel on GRYND — a rated 1v1 Solitaire race. Both players get the EXACT SAME deterministic Klondike deal and race it simultaneously: the first to solve the whole puzzle wins, and most progress wins if the clock runs out. No wagers, no betting, no tokens.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
