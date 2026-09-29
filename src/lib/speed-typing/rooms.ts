// src/lib/speed-typing/rooms.ts
//
// The CLIENT-SAFE Socket.IO vocabulary for Speed Typing: room ids and event
// names. This file imports nothing, so a client component can use it without
// pulling the game's server logic (rules, the passage catalog, the store) into
// the browser bundle. The server-side projection and broadcast helpers live in
// ./realtime.ts, which re-exports everything here.
//
// Mirrors `src/lib/mini-golf/rooms.ts`: centralised so the match view, the API
// routes and the standalone realtime server all agree on room naming — a typo
// in only one of them would silently break the per-match live channel.

/** Namespace prefix for the per-match live-update room. */
export const SPEED_TYPING_MATCH_ROOM_PREFIX = "speed-typing:match:";

/** Lobby-list refresh room (open Speed Typing lobbies). */
export const SPEED_TYPING_LOBBY_ROOM = "lobby:speed-typing";

/**
 * Per-match live-update room.
 *
 * One room per match, so an emission can never leak into another match's open
 * sockets. The match view joins exactly this room id on mount and RE-JOINS on
 * every (re)connect — Socket.IO does not restore room membership for you.
 */
export function speedTypingMatchRoom(matchId: string | number): string {
  return `${SPEED_TYPING_MATCH_ROOM_PREFIX}${matchId}`;
}

/**
 * Every realtime event the game uses.
 *
 * `MATCH_UPDATED` is the shared `"lobby:updated"` string every PvP game uses for
 * "something changed, refetch the snapshot" — the realtime server's generic
 * `room_event` relay routes it identically, and a client that only understands
 * that one event still works. The dedicated events below are the ones a client
 * can render without a refetch; each carries only server-derived fields.
 */
export const SPEED_TYPING_EVENTS = {
  /** Server → room: the lifecycle changed (joined / armed / resolved). Refetch. */
  MATCH_UPDATED: "lobby:updated",
  /** Client → server poke after a successful state-changing POST. */
  READY: "speed-typing:ready",
  /** Server → room: the absolute GO instant, so both seats count to one clock. */
  COUNTDOWN: "speed-typing:countdown",
  /** Server → room: typing is open. */
  MATCH_STARTED: "speed-typing:match-started",
  /** Server → room: a seat's OWN verified finish (server timestamp). */
  PLAYER_COMPLETED: "speed-typing:player-completed",
  /** Server → room: the race is resolved, with the authoritative result. */
  MATCH_FINISHED: "speed-typing:match-finished",
  /** Server → room: one seat's authoritative progress, projected for the opponent. */
  OPPONENT_PROGRESS: "speed-typing:opponent-progress",
} as const;

export type SpeedTypingEvent = (typeof SPEED_TYPING_EVENTS)[keyof typeof SPEED_TYPING_EVENTS];

/**
 * What the opponent is allowed to know about the other seat mid-race.
 *
 * Deliberately a closed shape: which seat, how far (as a percentage of the
 * prompt), whether the SERVER verified them done, and the server-derived
 * WPM/accuracy. No typed text, no error positions, no passage.
 */
export type OpponentProgress = {
  matchId?: string | number;
  /** Which seat this describes, so a client never guesses. */
  seatKey: "player1" | "player2";
  /** Verified cursor position as a percentage of the prompt, 0-100. */
  progressPercent: number;
  /** True only after the SERVER verified the whole prompt. */
  completed: boolean;
  /** Server-derived words per minute. */
  wpm: number;
  /** Server-derived accuracy percentage. */
  accuracy: number;
};
