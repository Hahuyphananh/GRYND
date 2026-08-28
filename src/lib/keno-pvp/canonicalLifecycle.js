import { createMatchLifecycle, transitionMatchLifecycle } from "../matchLifecycleStore";

function mirror(promise, label) {
  void promise.catch((error) => {
    console.error(`[keno-pvp] canonical lifecycle ${label} mirror failed`, error);
  });
}

export function mirrorKenoQueued({ matchId, playerCount, queuedAt }) {
  mirror(
    createMatchLifecycle({
      matchId,
      gameKey: "keno-pvp",
      mode: "pvp",
      playerCount: playerCount ?? 1,
      queuedAt,
    }),
    "queue",
  );
}

export function mirrorKenoTransition({ matchId, status, playerCount, cancelReason, at }) {
  mirror(
    transitionMatchLifecycle({
      matchId,
      to: status,
      playerCount,
      cancelReason,
      at,
    }),
    "transition",
  );
}
