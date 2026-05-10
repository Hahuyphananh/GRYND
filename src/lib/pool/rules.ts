import { Ball, PlayerTurn, RulesResult, Team } from "./types";

const isOwn = (n: number, team: Team) => team === "solids" ? n >= 1 && n <= 7 : n >= 9 && n <= 15;

const remaining = (balls: Ball[], team: Team) => balls.some((b) => !b.pocketed && !b.animatingPocket && b.number !== 8 && isOwn(b.number, team));

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
  const { balls, turn, myTurn, myTeam, oppTeam, openTable, firstContact, railAfterContact, pocketed, scratch } = params;
  let assignedMyTeam = myTeam;
  let assignedOppTeam = oppTeam;
  let foul = false;
  let foulMessage: string | null = null;
  let winner: PlayerTurn | null = null;

  const shooterTeam = turn === myTurn ? myTeam : oppTeam;
  const shooterCleared = shooterTeam ? !remaining(balls, shooterTeam) : false;

  if (openTable) {
    if (firstContact === 8) { foul = true; foulMessage = "Illegal 8-ball"; }
  } else if (shooterTeam) {
    const legalFirst = shooterCleared ? firstContact === 8 : !!firstContact && isOwn(firstContact, shooterTeam);
    if (!legalFirst) { foul = true; foulMessage = "Wrong ball hit first"; }
  }

  if (!railAfterContact && pocketed.length === 0 && !foul) { foul = true; foulMessage = "No rail after contact"; }
  if (scratch) { foul = true; foulMessage = "Scratch!"; }

  const firstColored = pocketed.find((n) => n !== 0 && n !== 8);
  if (openTable && firstColored && !foul) {
    const shooterGets = firstColored <= 7 ? "solids" : "stripes";
    assignedMyTeam = turn === myTurn ? shooterGets : shooterGets === "solids" ? "stripes" : "solids";
    assignedOppTeam = assignedMyTeam === "solids" ? "stripes" : "solids";
  }

  const sunkEight = pocketed.includes(8);
  const shooterAssigned = turn === myTurn ? assignedMyTeam : assignedOppTeam;
  const shooterDone = shooterAssigned ? !remaining(balls, shooterAssigned) : false;

  if (sunkEight) {
    if (!shooterAssigned || !shooterDone || scratch || foul) winner = turn === 1 ? 2 : 1;
    else winner = turn;
  }

  const ownPocket = pocketed.some((n) => shooterAssigned && isOwn(n, shooterAssigned));
  const keepTurn = ownPocket && !foul;
  const nextTurn: PlayerTurn = keepTurn ? turn : turn === 1 ? 2 : 1;

  return { foul, foulMessage, nextTurn, ballInHand: foul, winner, assignedMyTeam, assignedOppTeam, keepTurn };
}
