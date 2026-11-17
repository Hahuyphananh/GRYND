import type { Metadata } from "next";

import LearnPracticePage from "../../../components/learn/LearnPracticePage";
import { pageMetadata, DEFAULT_OG_IMAGE } from "../../../lib/seo";

export const metadata = pageMetadata({
  title: "Practice — GRYND Academy",
  description: "Repeatable Solitaire skill drills on prepared boards, played with the real rules. Practice is separate from the structured courses and never changes your competitive record.",
  path: "/learn/practice",
  image: DEFAULT_OG_IMAGE,
});

type PracticeSearchParams = {
  skill?: string | string[];
  difficulty?: string | string[];
};

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Coaching recommendations deep-link here with `?skill=<id>&difficulty=<level>`.
 * The values are only a starting selection: `LearnPracticePage` validates them
 * against the authored practice catalog and falls back to the first skill/level
 * when either is unknown, so a hand-edited URL cannot select a missing drill.
 */
export default async function LearnPracticeRoute({
  searchParams,
}: {
  searchParams: Promise<PracticeSearchParams>;
}) {
  const params = await searchParams;
  return (
    <LearnPracticePage
      initialSkillId={first(params.skill)}
      initialDifficulty={first(params.difficulty)}
    />
  );
}
