import { yahtzeeRegistration } from "./yahtzeeHandler";

export function registerYahtzeeGame(registry: { registerGame: (name: string, handler: unknown) => void }) {
  registry.registerGame("yahtzee", yahtzeeRegistration.handler);
}

export const YAHTZEE_REQUIRED_ENV = ["DATABASE_URL", "SOCKET_SERVER_URL"] as const;
