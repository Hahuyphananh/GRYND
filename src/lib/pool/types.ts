export type Team = "solids" | "stripes" | null;
export type PlayerTurn = 1 | 2;

export type Ball = {
  id: number;
  number: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  striped: boolean;
  pocketed: boolean;
  animatingPocket?: boolean;
  opacity?: number;
  scale?: number;
  pocketTarget?: { x: number; y: number };
};

export type ShotMeta = {
  firstContactNumber: number | null;
  railAfterContact: boolean;
  pocketedNumbers: number[];
  cueScratch: boolean;
};

export type RulesResult = {
  foul: boolean;
  foulMessage: string | null;
  nextTurn: PlayerTurn;
  ballInHand: boolean;
  winner: PlayerTurn | null;
  assignedMyTeam: Team;
  assignedOppTeam: Team;
  keepTurn: boolean;
};

export type ShotLifecycle = "IDLE" | "SHOOTING" | "ROLLING" | "SETTLED";

export type SyncedState = {
  balls: Ball[];
  turn: PlayerTurn;
  myTeam: Team;
  oppTeam: Team;
  openTable: boolean;
  ballInHand: boolean;
  winner: PlayerTurn | null;
  version: number;
  perspectiveSeat?: PlayerTurn;
  foul?: boolean;
  foulMessage?: string | null;
  lifecycle?: ShotLifecycle;
  shotId?: string | null;
  settled?: boolean;
};
