import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },

  title: "Player Profile | GRYND",
  description:
    "View a GRYND player's profile. Level, titles, statistics and recent results.",
};

export default function Page() {
  return <PageClient />;
}
