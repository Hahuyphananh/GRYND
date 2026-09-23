import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata: Metadata = {
  title: "Four-In-A-Row | GRYND",
  description:
    "Play Four-In-A-Row on GRYND. Stake tokens and challenge another player in a 1v1 duel, or play the AI for free.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
