import { diceFlushRegistration } from "./diceFlushHandler";

export function registerDiceFlushGame(registry: { registerGame: (name: string, handler: unknown) => void }) {
  registry.registerGame("yahtzee", diceFlushRegistration.handler);
}

export const DICE_FLUSH_REQUIRED_ENV = ["DATABASE_URL", "SOCKET_SERVER_URL"] as const;
