import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata: Metadata = {
  title: "Sudoku Duel | GRYND",
  description:
    "Play Sudoku Duel on GRYND — a rated 1v1 Sudoku race. Both players receive the EXACT SAME server-generated 9x9 puzzle and solve it simultaneously: the first to fill the board correctly wins, and the greatest verified progress wins if the clock runs out. No wagers, no betting, no tokens.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
