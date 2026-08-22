import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Hex Duel — GoonBet",
  description:
    "Play Hex Duel on GoonBet — strategic hex-grid territory conquest. Capture tiles, outmaneuver your opponent and dominate the board.",
};

export default function Page() {
  return <PageClient />;
}
