import { farkleRegistration } from "./farkleHandler";

export function registerFarkleGame(registry: {
  registerGame: (name: string, handler: unknown) => void;
}) {
  registry.registerGame("farkle", farkleRegistration.handler);
}

export const FARKLE_REQUIRED_ENV = ["DATABASE_URL", "SOCKET_SERVER_URL"] as const;
