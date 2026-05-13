import { Ball, PlayerTurn, RulesResult, Team } from "./types";

const isOwn = (n: number, team: Team) =>
  team === "solids" ? n >= 1 && n <= 7 : n >= 9 && n <= 15;

const isObjectBall = (n: number | null) => !!n && n > 0;

const remaining = (balls: Ball[], team: Team) =>
  balls.some(
    (b) =>
      !b.pocketed &&
      !b.animatingPocket &&
      b.number !== 8 &&
      isOwn(b.number, team),
  );

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

  if (!isObjectBall(firstContact)) {
    setFoul("Foul: cue ball did not contact an object ball.");
  } else if (openTable) {
    if (firstContact === 8) {
      setFoul("Foul: the 8-ball cannot be struck first on an open table.");
    }
  } else if (shooterTeam) {
    const shooterCleared = !remaining(balls, shooterTeam);
    const legalFirst = shooterCleared
      ? firstContact === 8
      : isOwn(firstContact, shooterTeam);
    if (!legalFirst) {
      setFoul(
        shooterCleared
          ? "Foul: hit your group before shooting the 8-ball."
          : "Foul: wrong ball hit first.",
      );
    }
  }

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
