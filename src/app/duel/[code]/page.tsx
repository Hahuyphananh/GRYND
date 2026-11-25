import type { Metadata } from "next";

import PageClient from "./PageClient";
import { normalizeFriendChallengeCode } from "../../../lib/solitaire-duel/friendChallenge";

// The friend-challenge landing page. A shared link is a private table, so this
// route is NEVER indexed: it is not a page anyone should find by searching, and
// its only job is to seat the person the link was sent to.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Friend Challenge | GRYND Solitaire Duel",
  description:
    "A private Solitaire Duel: one deterministic Klondike deal, both players, first to solve it wins.",
};

export default async function Page({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const resolved = (await params) || ({} as { code?: string });
  // Normalise on the server so the client receives either a canonical code or
  // null — a malformed path never reaches the API.
  const code = normalizeFriendChallengeCode(resolved.code);
  return <PageClient code={code} />;
}
