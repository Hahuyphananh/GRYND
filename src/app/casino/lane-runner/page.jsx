import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata = {
  title: "Lane Rush Duel | GRYND",
  description:
    "Play Lane Rush Duel on GRYND. Race a rival up the same tower — every safe pick either of you makes narrows the odds. Bank your score before the bad tile finds you.",
  openGraph: { images: [ogImageUrl("/images/og/lane-runner.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
