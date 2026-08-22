import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata = {
  title: "Crash Arena — GoonBet",
  description:
    "Join a Crash Arena table on GoonBet — everyone antes up, watch the multiplier fly and cash out before the crash. Last survivor claims the pot.",
  openGraph: { images: [ogImageUrl("/images/og/crash-arena.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
