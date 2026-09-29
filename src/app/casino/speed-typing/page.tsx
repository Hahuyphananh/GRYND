import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata: Metadata = {
  title: "Speed Typing | GRYND",
  description:
    "Play Speed Typing on GRYND — a rated 1v1 typing race. Both players get the exact same passage and race to type it fastest: the first to finish it correctly wins. No wagers, no randomness.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
