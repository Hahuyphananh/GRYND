import { Ball, PlayerTurn, RulesResult, Team } from "./types";

const isOwn = (n: number, team: Team) =>
  team === "solids" ? n >= 1 && n <= 7 : n >= 9 && n <= 15;

const isObjectBall = (n: number | null): n is number => !!n && n > 0;

const remaining = (balls: Ball[], team: Team) =>
  balls.some(
    (b) =>
      !b.pocketed &&
      !b.animatingPocket &&
      b.number !== 8 &&
      isOwn(b.number, team),
  );

/**
 * First-contact verdict, shared by the rules engine and the aim guide so the
 * guide can never warn about a foul the ruling would not call — or stay quiet
 * about one it would.
 *
 * `team` is the shooter's group, or null while the table is open. A shooter who
 * has cleared their group has no first-contact restriction left: contacting any
 * object ball is legal (the old "must strike the 8 first" foul was removed), so
 * an 8-ball-first contact is only ever judged on an open table.
 *
 * Returns the foul message, or null when the contact is legal.
 */
export function firstContactFoul(params: {
  balls: Ball[];
  team: Team | null;
  openTable: boolean;
  firstContact: number | null;
}): string | null {
  const { balls, team, openTable, firstContact } = params;

  if (!isObjectBall(firstContact)) {
    return "Foul: cue ball did not contact an object ball.";
  }

  if (openTable) {
    return firstContact === 8
      ? "Foul: the 8-ball cannot be struck first on an open table."
      : null;
  }

  if (!team || !remaining(balls, team)) return null;

  return isOwn(firstContact, team) ? null : "Foul: wrong ball hit first.";
}

export function evaluateRules(params: {
  balls: Ball[];
  turn: PlayerTurn;
  myTurn: PlayerTurn;
  myTeam: Team;
  oppTeam: Team;
  openTable: boolean;
  firstContact: number | null;
  railAfterContact: boolean;
  pocketed: number[];
  scratch: boolean;
}): RulesResult {
  const {
    balls,
    turn,
    myTurn,
    myTeam,
    oppTeam,
    openTable,
    firstContact,
    railAfterContact,
    pocketed,
    scratch,
  } = params;
  let assignedMyTeam = myTeam;
  let assignedOppTeam = oppTeam;
  let foul = false;
  let foulMessage: string | null = null;
  let winner: PlayerTurn | null = null;

  const shooterTeam = turn === myTurn ? myTeam : oppTeam;
  const opponentTurn: PlayerTurn = turn === 1 ? 2 : 1;
  const setFoul = (message: string) => {
    if (!foul) foulMessage = message;
    foul = true;
  };

  if (scratch) setFoul("Foul: cue ball scratch. Ball in hand.");

  // Ruled by the same helper the aim guide reads, so the guide's warning and
  // the engine's foul can never disagree.
  const contactFoul = firstContactFoul({
    balls,
    team: shooterTeam,
    openTable,
    firstContact,
  });
  if (contactFoul) setFoul(contactFoul);

  if (
    isObjectBall(firstContact) &&
    !railAfterContact &&
    pocketed.length === 0
  ) {
    setFoul(
      "Foul: no ball was pocketed and no ball reached a rail after contact.",
    );
  }

  const firstColored = pocketed.find((n) => n !== 0 && n !== 8);
  if (openTable && firstColored && !foul) {
    const shooterGets = firstColored <= 7 ? "solids" : "stripes";
    assignedMyTeam =
      turn === myTurn
        ? shooterGets
        : shooterGets === "solids"
          ? "stripes"
          : "solids";
    assignedOppTeam = assignedMyTeam === "solids" ? "stripes" : "solids";
  }

  const sunkEight = pocketed.includes(8);
  const shooterAssigned = turn === myTurn ? assignedMyTeam : assignedOppTeam;
  const shooterDone = shooterAssigned
    ? !remaining(balls, shooterAssigned)
    : false;

  if (sunkEight) {
    if (!shooterAssigned || !shooterDone || scratch || foul)
      winner = opponentTurn;
    else winner = turn;
  }

  const ownPocket = pocketed.some(
    (n) => shooterAssigned && isOwn(n, shooterAssigned),
  );
  const keepTurn = ownPocket && !foul && !winner;
  const nextTurn: PlayerTurn = keepTurn ? turn : opponentTurn;

  return {
    foul,
    foulMessage,
    nextTurn,
    ballInHand: foul,
    winner,
    assignedMyTeam,
    assignedOppTeam,
    keepTurn,
  };
}
