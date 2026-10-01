import type { Metadata } from "next";
import PageClient from "./PageClient";

// A dynamic match route — like every other `[matchId]` route on the platform it
// deliberately carries NO ad tag (tests/adsense.test.mjs pins that rule for all
// dynamic routes, because a live board must never be framed by an ad).
export const metadata: Metadata = {
  title: "Sudoku Duel Match | GRYND",
  description:
    "A rated 1v1 Sudoku Duel — both players race the exact same server-generated 9x9 puzzle, and the first to fill the board correctly wins.",
};

export default function Page() {
  return <PageClient />;
}
