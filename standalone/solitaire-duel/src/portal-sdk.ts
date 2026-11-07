// standalone/solitaire-duel/src/portal-sdk.ts
//
// THE ONLY PLACE A PORTAL SDK MAY BE REACHED — and it is unreachable unless the
// build explicitly asks for it.
//
// A portal SDK is a third-party script fetched from the portal's CDN. That is a
// genuine external network request, which is exactly what a default package
// promises never to make. So the adapter is gated twice:
//
//   * `__PORTAL_SDK__` is `"none"` unless `PORTAL_SDK=crazygames` was set for
//     the build; with "none" every method below returns before touching the
//     DOM, the network, or `window`;
//   * even when enabled, the SDK script is injected at RUNTIME and its failure
//     (offline, blocked, ad-blocker, CDN down) is swallowed — the game plays
//     identically without it.
//
// Deliberately NOT here: ads, account linking, leaderboards, analytics. The
// package still ships no persistence and no result upload; the SDK is used only
// for the lifecycle signals the portal requires (loading, gameplay start/stop,
// and one celebration when the player wins).
//
// Docs: https://docs.crazygames.com/sdk/html5-v2/game/

export type PortalRuntimeName = "none" | "crazygames";

type CrazyGamesGame = {
  sdkGameLoadingStart?: () => unknown;
  sdkGameLoadingStop?: () => unknown;
  gameplayStart?: () => unknown;
  gameplayStop?: () => unknown;
  happytime?: () => unknown;
};

type CrazyGamesSdk = {
  init?: () => unknown;
  game?: CrazyGamesGame;
};

// Read once, at module load. Outside Vite (the test suite) the identifier does
// not exist at all, so `typeof` is the only safe way to touch it.
const MODE: PortalRuntimeName =
  typeof __PORTAL_SDK__ === "string" && __PORTAL_SDK__ === "crazygames" ? "crazygames" : "none";

const SDK_SCRIPT_URL = "https://sdk.crazygames.com/crazygames-sdk-v2.js";
const INIT_TIMEOUT_MS = 4000;

let booted = false;
let sdk: CrazyGamesSdk | null = null;

/**
 * Call into the SDK without ever letting it break the game. A rejected promise
 * and a thrown error are the same thing here: ignored.
 */
function quietly(action: () => unknown): void {
  try {
    const value = action();
    if (value && typeof (value as Promise<unknown>).then === "function") {
      (value as Promise<unknown>).then(undefined, () => {});
    }
  } catch {
    // Deliberately silent: a portal SDK must never surface to the player.
  }
}

function hostSdk(): CrazyGamesSdk | null {
  const host = (window as unknown as { CrazyGames?: { SDK?: CrazyGamesSdk } }).CrazyGames;
  return host?.SDK ?? null;
}

/**
 * Inject the SDK script and resolve whatever happens — load, error, or a CDN
 * that never answers. The game never waits for it; the timeout is only so a
 * dead CDN does not leave the adapter half-initialised.
 */
function loadSdkScript(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve();
      return;
    }
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const script = document.createElement("script");
    script.async = true;
    script.src = SDK_SCRIPT_URL;
    script.addEventListener("load", settle, { once: true });
    script.addEventListener("error", settle, { once: true });
    document.head.appendChild(script);
    window.setTimeout(settle, INIT_TIMEOUT_MS);
  });
}

export const PORTAL_RUNTIME = {
  /** Which adapter this package was built with. "none" in every default build. */
  name: MODE,

  /** Called once, on mount. Starts the portal's loading measurement. */
  boot(): void {
    if (MODE !== "crazygames" || booted) return;
    booted = true;
    if (typeof document === "undefined") return;

    void loadSdkScript().then(() => {
      const loaded = hostSdk();
      if (!loaded) return; // blocked or unavailable: play on, silently
      sdk = loaded;
      quietly(() => loaded.init?.());
      quietly(() => loaded.game?.sdkGameLoadingStart?.());
    });
  },

  /** The first screen is up; the portal may stop counting load time. */
  loaded(): void {
    const active = sdk;
    if (!active) return;
    quietly(() => active.game?.sdkGameLoadingStop?.());
  },

  /** The player can move: a live match. */
  enterMatch(): void {
    const active = sdk;
    if (!active) return;
    quietly(() => active.game?.gameplayStart?.());
  },

  /** Result screen, menu, or a break: the portal may resume background work. */
  leaveMatch(): void {
    const active = sdk;
    if (!active) return;
    quietly(() => active.game?.gameplayStop?.());
  },

  /** The player won. One celebration, never on a loss. */
  celebrate(): void {
    const active = sdk;
    if (!active) return;
    quietly(() => active.game?.happytime?.());
  },
} as const;
