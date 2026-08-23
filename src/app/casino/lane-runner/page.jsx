import { ogImageUrl } from "../../../lib/ogImages";
import PageClient from "./PageClient";

export const metadata = {
  title: "Lane Rush Duel | GRYND",
  description:
    "Play Lane Rush Duel on GRYND. Race your tower against a rival. Pick safe tiles to climb or bank your score before the bad tile finds you.",
  openGraph: { images: [ogImageUrl("/images/og/lane-runner.jpg")] },
};

export default function Page() {
  return <PageClient />;
}
