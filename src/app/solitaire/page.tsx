import type { Metadata } from "next";

import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Solo Solitaire — play Klondike alone",
  description:
    "Play classic Klondike Solitaire alone on GRYND. Timed, with undo, move counter and personal bests. Unrated — solo games never affect your ranked Elo.",
  alternates: { canonical: "/solitaire" },
};

export default function Page() {
  return <PageClient />;
}
