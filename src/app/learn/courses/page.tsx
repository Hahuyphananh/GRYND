import type { Metadata } from "next";

import LearnCoursesPage from "../../../components/learn/LearnCoursesPage";

export const metadata: Metadata = {
  title: "Courses — GRYND Academy",
  description:
    "Five structured Solitaire courses, from understanding the board to advanced planning. Track progress and replay any lesson.",
  alternates: { canonical: "/learn/courses" },
};

export default function LearnCoursesRoute() {
  return <LearnCoursesPage />;
}
