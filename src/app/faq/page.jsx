import PageClient from "./PageClient";
import { HELP_FEATURED_SLUGS, gameIndexFor } from "../../lib/gameLandingPages";

export const metadata = {
  alternates: { canonical: "/faq" },
  title: "FAQ | GRYND",
  description:
    "Answers to the most common questions about GRYND: tokens, gameplay, PvP duels, leaderboards, levels, referrals, reviews, account deletion and more.",
};

export default function Page() {
  // The games this help page points at, as real links to their public pages
  // (/games/<slug>). Resolved from the game catalogue on the SERVER and passed
  // down as plain data: the catalogue's entries carry every game's full prose
  // and this page is a client component. Unknown slugs are dropped by
  // gameIndexFor, so a renamed game can never leave a link to a 404 here.
  const helpGames = gameIndexFor(HELP_FEATURED_SLUGS);

  return <PageClient helpGames={helpGames} />;
}
