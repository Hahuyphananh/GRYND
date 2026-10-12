import PageClient from "./PageClient";
import { GAME_CARDS } from "../../lib/gameLandingPages";

export const metadata = {
  alternates: { canonical: "/faq" },
  title: "FAQ | GRYND",
  description:
    "Answers to the most common questions about GRYND — tokens, gameplay, PvP duels, leaderboards, levels, referrals, reviews, account deletion — plus a directory of every game's own rules page.",
};

export default function Page() {
  // EVERY public game, as a card, resolved from the game catalogue on the
  // SERVER and passed down as plain data: the catalogue's entries carry every
  // game's full prose, and this page only needs the card fields off them.
  //
  // The cards link each game's OWN page — the info page at /games/<slug>, which
  // is public and explains the rules — and deliberately NOT the lobby at
  // /games/<slug>/play, which sits behind a sign-in and carries no rules to
  // read. `GAME_CARDS` is derived from `GAME_LANDING_PAGES`, so a game added to
  // the catalogue appears here without anyone remembering to add a card.
  return <PageClient gameCards={GAME_CARDS} />;
}
