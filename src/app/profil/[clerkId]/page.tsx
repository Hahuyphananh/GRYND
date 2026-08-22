import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Player Profile — GoonBet",
  description:
    "View a GoonBet player's profile — level, titles, statistics and recent results.",
};

export default function Page() {
  return <PageClient />;
}
