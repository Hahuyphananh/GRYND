import PageClient from "./PageClient";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "Fair Play Policy",
  description: "GRYND is 100% skill-based and fair. Read our anti-cheating measures, game integrity rules and responsible-gaming commitment.",
  path: "/fair-play",
  image: DEFAULT_OG_IMAGE,
});

export default function Page() {
  return <PageClient />;
}
