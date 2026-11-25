import type { Metadata } from "next";
import { notFound } from "next/navigation";

import LessonPlayer from "../../../components/learn/LessonPlayer";
import { LEARN_TRANSLATIONS } from "../../../lib/learnTranslations";
import { lessonById } from "../../../lib/solitaire-duel/lessonCatalog";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lessonId: string }>;
}): Promise<Metadata> {
  const { lessonId } = await params;
  const lesson = lessonById(lessonId);
  if (!lesson) return { title: "Lesson not found — GRYND" };

  return {
    title: `${LEARN_TRANSLATIONS.en.lessons[lesson.id]?.title ?? lesson.id} — GRYND Academy`,
    description:
      "An interactive Solitaire lesson on GRYND. Prepared board, real rules and no penalty for retrying.",
    alternates: { canonical: `/learn/${lesson.id}` },
    robots: { index: false, follow: true },
  };
}

export default async function LessonPage({
  params,
}: {
  params: Promise<{ lessonId: string }>;
}) {
  const { lessonId } = await params;
  const lesson = lessonById(lessonId);
  if (!lesson) notFound();

  return <LessonPlayer lessonId={lesson.id} />;
}
