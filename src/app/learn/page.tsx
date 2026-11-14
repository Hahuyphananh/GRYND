import type { Metadata } from "next";

import LearnLanding from "../../components/learn/LearnLanding";

export const metadata: Metadata = {
  title: "GRYND Academy — guided Solitaire lessons",
  description:
    "Learn Klondike Solitaire with a three-part video guide and short, interactive lessons. Prepared boards, real rules, progressive hints and no penalty for retrying.",
  alternates: { canonical: "/learn" },
  openGraph: {
    title: "GRYND Academy — video and interactive Solitaire lessons",
    description:
      "A three-part video guide plus short interactive lessons: the stock, the tableau, foundations, sequences and revealing hidden cards.",
    url: "/learn",
    type: "website",
  },
};

export default function LearnPage() {
  return <LearnLanding />;
}
