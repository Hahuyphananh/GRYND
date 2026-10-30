// src/lib/native/appLifecycle.ts
//
// Native lifecycle / network event contract for the Capacitor shell.
//
// Phase 3A only DETECTS and PUBLISHES these signals. Nothing here reconnects a
// socket, refetches a match or changes gameplay — Phase 3B consumes the events
// below to coordinate Socket.IO recovery.
//
// The contract is deliberately small: two DOM CustomEvents on `window`, with
// typed payloads, plus subscribe helpers. No state library, no context, no
// singleton store.
//
//   grynd:app-state-change        { isActive: boolean }
//   grynd:network-status-change   { connected: boolean, connectionType: NetworkConnectionType }
//
// Everything in `emit*`/`subscribe*` is safe during server rendering: with no
// `window` (or no CustomEvent constructor) they are silent no-ops. The actual
// plugin listeners are attached by `src/components/native/NativeLifecycleBridge`,
// which is native-only.

/** Fired when the app enters the foreground or disappears into the background. */
export const APP_STATE_CHANGE_EVENT = "grynd:app-state-change" as const;

/** Fired when the device's network interface changes (not server reachability). */
export const NETWORK_STATUS_CHANGE_EVENT = "grynd:network-status-change" as const;

/**
 * Capacitor's `ConnectionType` reduced to the four states the app acts on.
 * `unknown` is the safe default for a missing/unrecognised value.
 */
export type NetworkConnectionType = "wifi" | "cellular" | "none" | "unknown";

/** Payload of `grynd:app-state-change`. */
export type AppStateChangeDetail = {
  /** true = foreground (interactive), false = background. */
  isActive: boolean;
};

/**
 * Payload of `grynd:network-status-change`.
 *
 * `connected` describes the NETWORK INTERFACE, not the GRYND server: a device
 * on hotel Wi-Fi is "connected" while the API and the Socket.IO host may both
 * be unreachable. Server reachability is a separate concern (Phase 3B).
 */
export type NetworkStatusChangeDetail = {
  connected: boolean;
  connectionType: NetworkConnectionType;
};

/**
 * Normalise any plugin-reported connection type onto the payload union.
 *
 * Capacitor reports `"wifi" | "cellular" | "none" | "unknown"`, but the value
 * crosses a native bridge, so it is treated as untrusted input here.
 */
export function normalizeConnectionType(value: unknown): NetworkConnectionType {
  if (value === "wifi" || value === "cellular" || value === "none") {
    return value;
  }
  return "unknown";
}

/** Resolve the event bus: the explicit target (tests) or `window`, if any. */
function resolveTarget(target?: EventTarget | null): EventTarget | null {
  if (target) return target;
  if (typeof window === "undefined") return null;
  return window;
}

/** Publish one typed event. Silent no-op where there is no DOM (SSR, tests). */
function emit<T>(type: string, detail: T, target?: EventTarget | null): void {
  const sink = resolveTarget(target);
  if (!sink) return;
  if (typeof CustomEvent !== "function") return;
  sink.dispatchEvent(new CustomEvent<T>(type, { detail }));
}

/** Publish `grynd:app-state-change`. */
export function emitAppStateChange(
  detail: AppStateChangeDetail,
  target?: EventTarget | null,
): void {
  emit(APP_STATE_CHANGE_EVENT, { isActive: detail.isActive === true }, target);
}

/** Publish `grynd:network-status-change`. */
export function emitNetworkStatusChange(
  detail: NetworkStatusChangeDetail,
  target?: EventTarget | null,
): void {
  emit(
    NETWORK_STATUS_CHANGE_EVENT,
    {
      connected: detail.connected === true,
      connectionType: normalizeConnectionType(detail.connectionType),
    },
    target,
  );
}

/** Subscribe to one typed event; returns an unsubscribe function. */
function subscribe<T>(
  type: string,
  handler: (detail: T) => void,
  target?: EventTarget | null,
): () => void {
  const sink = resolveTarget(target);
  if (!sink || typeof handler !== "function") return () => {};

  const listener = (event: Event) => {
    const detail = (event as CustomEvent<T | null | undefined>).detail;
    if (!detail) return;
    handler(detail as T);
  };

  sink.addEventListener(type, listener);
  return () => sink.removeEventListener(type, listener);
}

/**
 * Subscribe to foreground/background changes.
 *
 * ```ts
 * const off = subscribeToAppStateChange(({ isActive }) => { ... });
 * off(); // on unmount
 * ```
 */
export function subscribeToAppStateChange(
  handler: (detail: AppStateChangeDetail) => void,
  target?: EventTarget | null,
): () => void {
  return subscribe(APP_STATE_CHANGE_EVENT, handler, target);
}

/** Subscribe to network-interface changes (see the reachability note above). */
export function subscribeToNetworkStatusChange(
  handler: (detail: NetworkStatusChangeDetail) => void,
  target?: EventTarget | null,
): () => void {
  return subscribe(NETWORK_STATUS_CHANGE_EVENT, handler, target);
}

// ── Plugin binding ────────────────────────────────────────────────────────
//
// The structural types below intentionally describe only what this phase uses,
// so the real `App`/`Network` plugin objects satisfy them and a test double can
// too. Keeping the binding here (rather than inside the React component) means
// the ordering, initial-state reads and cleanup rules are testable without a
// DOM or a Capacitor runtime.

/** The `remove()` handle both plugins return from `addListener`. */
export type LifecycleListenerHandle = {
  remove(): Promise<void> | void;
};

/** The subset of `@capacitor/app` this phase depends on. */
export type AppLifecyclePlugin = {
  getState(): Promise<{ isActive: boolean }>;
  addListener(
    eventName: "appStateChange",
    listener: (state: { isActive: boolean }) => void,
  ): Promise<LifecycleListenerHandle>;
};

/** The subset of `@capacitor/network` this phase depends on. */
export type NetworkLifecyclePlugin = {
  getStatus(): Promise<{ connected: boolean; connectionType: string }>;
  addListener(
    eventName: "networkStatusChange",
    listener: (status: { connected: boolean; connectionType: string }) => void,
  ): Promise<LifecycleListenerHandle>;
};

export type NativeLifecycleWatchOptions = {
  app: AppLifecyclePlugin;
  network: NetworkLifecyclePlugin;
  emitAppState: (detail: AppStateChangeDetail) => void;
  emitNetworkStatus: (detail: NetworkStatusChangeDetail) => void;
  /** Optional diagnostics. Receives the error only — never tokens or state. */
  onError?: (error: unknown) => void;
};

/**
 * Attach the native listeners, publish the INITIAL state of both plugins, and
 * return a `stop()` that detaches everything.
 *
 * Rules this function guarantees:
 *  - the initial state is always read, never assumed (an app can be mounted
 *    while backgrounded, and a device can boot without a network);
 *  - a `stop()` during the async setup unregisters any handle that arrives
 *    afterwards, so unmounting mid-initialisation cannot leak a listener;
 *  - one plugin failing does not prevent the other from working;
 *  - every emission is suppressed after `stop()`.
 */
export function startNativeLifecycleWatch(
  options: NativeLifecycleWatchOptions,
): () => void {
  const { app, network, emitAppState, emitNetworkStatus, onError } = options;

  let stopped = false;
  const handles: LifecycleListenerHandle[] = [];

  const report = (error: unknown) => {
    try {
      onError?.(error);
    } catch {
      // A broken diagnostic callback must never break the bridge.
    }
  };

  const track = (handle: LifecycleListenerHandle | null | undefined) => {
    if (!handle) return;
    if (stopped) {
      // The component unmounted while `addListener` was resolving. Remove the
      // handle immediately rather than leaving a native listener attached.
      try {
        void handle.remove();
      } catch {
        // Already detached.
      }
      return;
    }
    handles.push(handle);
  };

  void (async () => {
    // Application state — read first, then subscribe. A missed transition
    // between the two is impossible because the read reports the current state
    // and the listener is attached immediately after.
    try {
      const state = await app.getState();
      if (!stopped) emitAppState({ isActive: state?.isActive === true });
    } catch (error) {
      report(error);
    }

    if (!stopped) {
      try {
        const handle = await app.addListener("appStateChange", (state) => {
          if (stopped) return;
          emitAppState({ isActive: state?.isActive === true });
        });
        track(handle);
      } catch (error) {
        report(error);
      }
    }

    // Network state — same read-then-subscribe order.
    try {
      const status = await network.getStatus();
      if (!stopped) {
        emitNetworkStatus({
          connected: status?.connected === true,
          connectionType: normalizeConnectionType(status?.connectionType),
        });
      }
    } catch (error) {
      report(error);
    }

    if (!stopped) {
      try {
        const handle = await network.addListener(
          "networkStatusChange",
          (status) => {
            if (stopped) return;
            emitNetworkStatus({
              connected: status?.connected === true,
              connectionType: normalizeConnectionType(status?.connectionType),
            });
          },
        );
        track(handle);
      } catch (error) {
        report(error);
      }
    }
  })();

  return () => {
    stopped = true;
    for (const handle of handles.splice(0)) {
      try {
        void handle.remove();
      } catch {
        // Already detached.
      }
    }
  };
}
