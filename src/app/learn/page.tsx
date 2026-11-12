import type { Metadata } from "next";

import LearnLanding from "../../components/learn/LearnLanding";

export const metadata: Metadata = {
  title: "Learn Solitaire — guided lessons",
  description:
    "Learn Klondike Solitaire one idea at a time with short, interactive lessons. Prepared boards, real rules, progressive hints and no penalty for retrying.",
  alternates: { canonical: "/learn" },
  openGraph: {
    title: "Learn Solitaire — guided lessons",
    description:
      "Short interactive Solitaire lessons: the stock, the tableau, foundations, sequences and revealing hidden cards.",
    url: "/learn",
    type: "website",
  },
};

export default function LearnPage() {
  return <LearnLanding />;
}
