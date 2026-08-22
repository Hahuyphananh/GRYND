import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Dots & Boxes — GRYND",
  description:
    "Play Dots & Boxes on GRYND — stake tokens and take turns drawing lines to claim the most boxes and win the pot.",
};

export default function Page() {
  return <PageClient />;
}
