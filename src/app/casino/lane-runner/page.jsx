import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata = {
  title: "Lane Rush Duel | GRYND",
  description:
    "Play Lane Rush Duel on GRYND. Race a rival across the same 10-row bridge — every row hides one bad tile. A safe step keeps your turn; one wrong step sends you back to Row 1. First across wins.",
  openGraph: { images: [ogImageUrl("/images/og/lane-runner.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
