import type { Metadata } from "next";
import PageClient from "./PageClient";

export const metadata: Metadata = {
  title: "Hex Duel — GRYND",
  description:
    "Play Hex Duel on GRYND — strategic hex-grid territory conquest. Capture tiles, outmaneuver your opponent and dominate the board.",
};

export default function Page() {
  return <PageClient />;
}
