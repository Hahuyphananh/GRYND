import { createMatchLifecycle, transitionMatchLifecycle } from "../matchLifecycleStore";

function mirror(promise, label) {
  void promise.catch((error) => {
    console.error(`[mines-pvp] canonical lifecycle ${label} mirror failed`, error);
  });
}

export function mirrorMinesQueued({ matchId, playerCount, queuedAt, mode = "pvp" }) {
  mirror(createMatchLifecycle({
    matchId: String(matchId),
    gameKey: "mines-pvp",
    mode,
    playerCount: playerCount ?? 1,
    queuedAt,
  }), "queue");
}

export function mirrorMinesTransition({ matchId, status, playerCount, cancelReason, at }) {
  mirror(transitionMatchLifecycle({
    matchId: String(matchId),
    to: status,
    playerCount,
    cancelReason,
    at,
  }), "transition");
}
