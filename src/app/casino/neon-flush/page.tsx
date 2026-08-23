import type { Metadata } from "next";
import { ogImageUrl } from "../../../lib/ogImages";
import NeonFlushPage from "../uno/page";

export const metadata: Metadata = {
  title: "Neon Flush | GRYND",
  description:
    "Play Neon Flush on GRYND. A fast strategic card game against the AI or other players.",
  openGraph: { images: [ogImageUrl("/images/og/neon-flush.jpg")] },
};

export default function Page() {
  return <NeonFlushPage />;
}
