import type { Metadata } from "next";

import PageClient from "./PageClient";

// The Battleship application screen. Like every other game LOBBY it is noindex:
// it is a client-side application, and the public, indexable page for a game is
// its /games/<slug> landing page (not part of this phase).
const title = "Battleship | GRYND";
const description =
  "Battleship on GRYND — a 1v1 naval duel on two hidden 10x10 boards. Place five ships, lock one shot each round, and sink the enemy fleet first.";

export const metadata: Metadata = {
  title,
  description,
  // The AUTHENTICATED application screen, served at /games/battleship/play by
  // the shared rewrite. Like every other game lobby it is `noindex` but
  // `follow`, and it canonicalises to its own play URL; the PUBLIC, indexable
  // page is /games/battleship, generated from src/lib/gameLandingPages.ts.
  alternates: { canonical: "/games/battleship/play" },
  robots: { index: false, follow: true },
  openGraph: { title, description, siteName: "GRYND", locale: "en_US", type: "website" },
};

export default function Page() {
  return <PageClient />;
}
