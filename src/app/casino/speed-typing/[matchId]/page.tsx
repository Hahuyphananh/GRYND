import type { Metadata } from "next";
import PageClient from "./PageClient";

// A dynamic match page — like every other `[matchId]` route on the platform it
// deliberately carries NO ad tag (tests/adsense.test.mjs pins that rule for all
// dynamic routes, because a board must never be framed by an ad).
export const metadata: Metadata = {
  title: "Speed Typing Match | GRYND",
  description:
    "A ranked 1v1 Speed Typing race — both players type the exact same passage and the first to finish it correctly wins.",
};

export default function Page() {
  return <PageClient />;
}
