// src/components/game-ui/index.ts
//
// THE SHARED GAME-SURFACE PRIMITIVES (stage 2 of the cartoon-2D redesign).
//
// Import from here so a game never reaches into a sibling file:
//
//   import { GameBoardFrame, GameCell, GamePiece, TurnBanner } from "../game-ui";
//
// All four are pure presentational components: no state, no data fetching, no
// game rules, and no browser globals, so they render identically on the server
// and in a client component (there is no "use client" here on purpose). They
// take their colour, outline, radius, motion and state treatments from the
// `--gr-*` tokens declared in src/app/globals.css, so a token change moves every
// adopter at once.
//
// Adopting them is opt-in and incremental: a game swaps one wrapper or one cell
// at a time. Nothing in this folder changes an existing game's behaviour.

export { GameBoardFrame, default as GameBoardFrameDefault } from "./GameBoardFrame";
export type {
  GameBoardFrameProps,
  GameBoardShape,
  GameBoardSurface,
} from "./GameBoardFrame";

export { GameCell, default as GameCellDefault } from "./GameCell";
export type { GameCellProps, GameSeat } from "./GameCell";

export { GamePiece, default as GamePieceDefault } from "./GamePiece";
export type { GamePieceProps, GamePieceSilhouette, GamePieceSize } from "./GamePiece";

export { TurnBanner, default as TurnBannerDefault } from "./TurnBanner";
export type { TurnBannerProps, TurnBannerTone } from "./TurnBanner";
