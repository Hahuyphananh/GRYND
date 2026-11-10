import type { Metadata } from "next";
import { notFound } from "next/navigation";

import type { ReviewGameKind } from "../../../../../lib/solitaire-duel/review";
import PageClient from "./PageClient";

const KINDS: ReviewGameKind[] = ["duel", "solo", "daily"];

export const metadata: Metadata = {
  title: "Solitaire Game Review — every move, replayed",
  description:
    "Review a completed GRYND Solitaire game move by move: the exact deal, the validated move log, and the board rebuilt at every position.",
  robots: { index: false, follow: false },
};

export default async function SolitaireReviewPage({
  params,
}: {
  params: Promise<{ kind: string; gameId: string }>;
}) {
  const { kind, gameId } = await params;
  if (!KINDS.includes(kind as ReviewGameKind)) notFound();
  return <PageClient kind={kind as ReviewGameKind} gameId={gameId} />;
}
