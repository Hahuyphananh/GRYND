import type { Metadata } from "next";

import LearnVideosPage from "../../../components/learn/LearnVideosPage";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../../lib/seo";

export const metadata = pageMetadata({
  title: "Videos — GRYND Academy",
  description: "The three-part Complete Guide to Solitaire video course, with a related interactive lesson for each part.",
  path: "/learn/videos",
  image: DEFAULT_OG_IMAGE,
});

export default function LearnVideosRoute() {
  return <LearnVideosPage />;
}
