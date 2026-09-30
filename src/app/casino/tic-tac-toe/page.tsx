import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata: Metadata = {
  title: "Tic-Tac-Toe | GRYND",
  description:
    "Play Tic-Tac-Toe on GRYND — a free, rated 1v1 duel on a 3x3 board. X moves first, play is turn by turn, and the first player to line up three in a row wins. Free to play, no tokens at stake.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
