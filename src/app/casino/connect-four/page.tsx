import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Connect Four — GRYND",
  description:
    "Play Connect Four on GRYND — stake tokens and challenge another player in a 1v1 duel, or play the AI for free.",
};

export default function Page() {
  return <PageClient />;
}
