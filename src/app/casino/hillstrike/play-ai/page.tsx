import type { Metadata } from "next";
import PageClient from "./PageClient";

// /casino/hillstrike/play-ai — free practice against the bot.
//
// The match is entirely client-side (see ./PageClient): the shared rules engine
// and the deterministic simulator run in the browser, there is no match row, no
// wager and no rating. The route is listed in GAME_ROUTE_PATTERNS (src/proxy.ts)
// so a signed-out visitor can read it, exactly like every other practice page.
export const metadata: Metadata = {
  title: "Hillstrike vs AI | GRYND",
  description:
    "Play Hillstrike free against the GRYND AI. Drag to set your angle and power, read the arc, drive in for more damage, build cover, and knock the enemy tank from 100 HP to zero before it does the same to you.",
};

export default function Page() {
  return <PageClient />;
}
