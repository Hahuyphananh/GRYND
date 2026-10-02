// src/lib/optimistic.ts
//
// Shared plumbing for controls that write data. It exists so every caller
// handles the three cases the same way:
//
//   1. apply the optimistic UI effect immediately (optional),
//   2. await the server request,
//   3. on failure, roll the effect back and surface a message.
//
// The point is the first step: the user's action is reflected at once instead
// of leaving the control looking frozen until the round trip finishes. Only
// use it where an optimistic update is safe — never for payments, account
// deletion, permissions, or a value only the server can decide (availability,
// remaining stock, game results).

export type OptimisticRun<T> = { ok: true; data: T } | { ok: false; error: string };

export type OptimisticOptions<T> = {
  /** Server call. Throw (or reject) to signal failure. */
  request: () => Promise<T>;
  /** Apply the change to the UI before the request resolves. */
  optimistic?: () => void;
  /** Undo `optimistic` when the request fails. */
  rollback?: () => void;
  /** Message shown when the failure carries no usable message of its own. */
  fallbackError?: string;
};

export async function runOptimistically<T>({
  request,
  optimistic,
  rollback,
  fallbackError = "Something went wrong. Please try again.",
}: OptimisticOptions<T>): Promise<OptimisticRun<T>> {
  try {
    optimistic?.();
    const data = await request();
    return { ok: true, data };
  } catch (err) {
    rollback?.();
    const message = err instanceof Error && err.message ? err.message : fallbackError;
    return { ok: false, error: message };
  }
}
