// ── Quick-Queue adapter for Precision ───────────────────────────────────
//
// The platform-wide quick queue pairs two requests and then asks each game's
// adapter to create/join a destination match. Precision's destination is its
// PvP lobby (the lobby id becomes the match id once the second player is
// paired), so this is a thin wrapper over `tryAutoMatch`:
//
//   source call  → no waiting lobby at that wager → new lobby (id X)
//   partner call → pairs into X                     → same id X
//
// The worker asserts both calls resolve to the SAME destination id, which is
// exactly what the atomic pairing in `matchmaking.ts` guarantees.
//
// It used to walk a process-local `precisionLobbyStore` Map and mutate it in
// place — under serverless that Map is per-instance, so the two calls (which
// can land on different instances) had no way to see each other and the
// destination id assertion failed.

import { tryAutoMatch } from "./precision/matchmaking";

export async function createOrJoinPrecisionDestination({
  userId,
  wager = 10,
  name = "Quick Queue Player",
}: {
  userId: string;
  wager?: number;
  name?: string;
}) {
  const amount = Math.trunc(Number(wager));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "Invalid Precision wager", status: 400 };
  }

  try {
    const result = await tryAutoMatch({
      wager: amount,
      hostUserId: userId,
      hostName: name,
    });
    return {
      match: { id: result.gameId },
      joined: result.status === "matched",
    };
  } catch (error) {
    console.error("[quick-queue] precision destination failed", error);
    return { error: "Unable to create Precision match", status: 500 };
  }
}
