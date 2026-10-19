// src/lib/hex-duel/seats.ts
//
// Who is looking at the Hex Duel board, and which engine seat is on each side
// of their screen.
//
// The engine always speaks in absolute seats (`player1` / `player2`). The page
// speaks in "local" and "opponent" — the cards either side of the board. These
// helpers are the single translation between the two, so a guest's avatar can
// never end up on the opponent card and a spectator can never be styled as a
// seat they do not hold.
//
// A spectator follows seat 1 (the same convention as the result view): player1
// is the local card, player2 is the opponent card. A participant follows their
// own seat, whichever one that is.

/** The two engine seats. */
export type DuelSeat = "player1" | "player2";

/** Which seat belongs on the viewer's side, and which is the opponent. */
export function viewerSeatsFor({
  isSpectator,
  isPlayer1,
}: {
  isSpectator: boolean;
  isPlayer1: boolean;
}): { local: DuelSeat; opponent: DuelSeat } {
  if (isSpectator) return { local: "player1", opponent: "player2" };
  return isPlayer1
    ? { local: "player1", opponent: "player2" }
    : { local: "player2", opponent: "player1" };
}

/**
 * One seat's cosmetic identity from a status/spectate payload.
 *
 * The payload carries ABSOLUTE seat fields (`player1Name`, `player2Name`, …),
 * so this always reads the seat that was asked for — never the viewer-relative
 * fields the old page mixed up.
 */
export function seatIdentityFrom(
  game:
    | {
        player1Name?: unknown;
        player2Name?: unknown;
        player1IconKey?: unknown;
        player2IconKey?: unknown;
        player1NameColor?: unknown;
        player2NameColor?: unknown;
        player1ProfileFrame?: unknown;
        player2ProfileFrame?: unknown;
      }
    | null
    | undefined,
  seat: DuelSeat,
): {
  name: string | null;
  iconKey: string | null;
  nameColor: string | null;
  profileFrame: unknown;
} {
  const name = seat === "player1" ? game?.player1Name : game?.player2Name;
  const iconKey = seat === "player1" ? game?.player1IconKey : game?.player2IconKey;
  const nameColor = seat === "player1" ? game?.player1NameColor : game?.player2NameColor;
  const profileFrame =
    seat === "player1" ? game?.player1ProfileFrame : game?.player2ProfileFrame;
  return {
    name: typeof name === "string" && name.length > 0 ? name : null,
    iconKey: typeof iconKey === "string" && iconKey.length > 0 ? iconKey : null,
    nameColor: typeof nameColor === "string" && nameColor.length > 0 ? nameColor : null,
    profileFrame: profileFrame ?? null,
  };
}
