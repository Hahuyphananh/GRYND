import type { Metadata } from "next";

import PageClient from "./PageClient";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "Solo Solitaire — play Klondike alone",
  description: "Play classic Klondike Solitaire alone on GRYND. Timed, with undo, move counter and personal bests. Unrated — solo games never affect your ranked Elo.",
  path: "/solitaire",
  image: DEFAULT_OG_IMAGE,
});

export default function Page() {
  return <PageClient />;
}
