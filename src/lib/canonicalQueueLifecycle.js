import { createMatchLifecycle, transitionMatchLifecycle } from "./matchLifecycleStore";

function fireAndForget(operation, gameKey, phase) {
  void operation.catch((error) => {
    console.error(`[${gameKey}] canonical lifecycle ${phase} mirror failed`, error);
  });
}

export function mirrorQueueCreated({ gameKey, matchId, mode = "pvp", playerCount = 1, queuedAt }) {
  fireAndForget(createMatchLifecycle({ matchId: String(matchId), gameKey, mode, playerCount, queuedAt }), gameKey, "queue");
}

export function mirrorQueueTransition({ gameKey, matchId, status, playerCount, cancelReason, at }) {
  fireAndForget(transitionMatchLifecycle({ matchId: String(matchId), to: status, playerCount, cancelReason, at }), gameKey, "transition");
}
