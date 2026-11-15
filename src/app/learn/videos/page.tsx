import type { Metadata } from "next";

import LearnVideosPage from "../../../components/learn/LearnVideosPage";

export const metadata: Metadata = {
  title: "Videos — GRYND Academy",
  description:
    "The three-part Complete Guide to Solitaire video course, with a related interactive lesson for each part.",
  alternates: { canonical: "/learn/videos" },
};

export default function LearnVideosRoute() {
  return <LearnVideosPage />;
}
