import type { Metadata } from "next";

import LearnCoursesPage from "../../../components/learn/LearnCoursesPage";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../../lib/seo";

export const metadata = pageMetadata({
  title: "Courses — GRYND Academy",
  description: "Five structured Solitaire courses, from understanding the board to advanced planning. Track progress and replay any lesson.",
  path: "/learn/courses",
  image: DEFAULT_OG_IMAGE,
});

export default function LearnCoursesRoute() {
  return <LearnCoursesPage />;
}
