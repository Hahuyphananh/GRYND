import type { Metadata } from "next";

import LearnLanding from "../../components/learn/LearnLanding";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../lib/seo";

export const metadata = pageMetadata({
  title: "GRYND Academy — guided Solitaire lessons",
  description: "Learn Klondike Solitaire with a three-part video guide and short, interactive lessons. Prepared boards, real rules, progressive hints and no penalty for retrying.",
  path: "/learn",
  image: DEFAULT_OG_IMAGE,
});

export default function LearnPage() {
  return <LearnLanding />;
}
