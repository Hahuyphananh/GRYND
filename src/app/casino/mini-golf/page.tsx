import type { Metadata } from "next";
import PageClient from "./PageClient";
import AdSenseScript from "../../../components/AdSenseScript";

export const metadata: Metadata = {
  title: "Mini Golf | GRYND",
  description:
    "Play Mini Golf on GRYND — a free 1v1, turn-based, physics-based duel. Best of 5 holes, first to 3 hole wins. Sink the putt and beat your opponent.",
};

export default function Page() {
  return (
    <>
      <AdSenseScript />
      <PageClient />
    </>
  );
}
