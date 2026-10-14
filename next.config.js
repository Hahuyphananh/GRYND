const withPWA = require("next-pwa")({
  dest: "public",
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === "development"
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ── Image qualities ─────────────────────────────────────────────────
  // Next 16 only honours a quality listed here (the default allowlist is
  // [75]): the shared game card asks for `quality={85}` on every card, and
  // without this the optimiser silently served 75 and logged a warning per
  // image, so the card art on /faq and in the lobby was not the quality the
  // component asked for. 75 stays allowed — everything else uses the default.
  images: {
    qualities: [75, 85],
  },

  turbopack: {
    // Pin the workspace root to this directory. Without this, Next infers the
    // root from stray lockfiles higher up the tree (e.g. C:\Users\client\package-lock.json)
    // and resolves imports against the wrong copy of the project.
    root: __dirname,
  },

  webpack: (config) => {
    config.externals = [...config.externals, { canvas: "canvas" }];
    return config;
  },

  // ── Game Evaluation — Stockfish (WASM) ──────────────────────────────
  // src/lib/evaluation/engine/stockfishEngine.ts runs the single-threaded
  // Stockfish 16 WASM build in-process (no native binaries, no workers, no
  // SharedArrayBuffer), which the Node.js runtime supports on Vercel
  // (vercel.com/docs/functions/runtimes/wasm). Two things have to be true for
  // that to work in a deployed function:
  //
  //   1. The package must stay EXTERNAL. Its Emscripten loader locates the
  //      .wasm relative to its own `__dirname`; if webpack bundles it, that
  //      path points into the server chunk and the engine fails to boot.
  //   2. The .wasm has to be TRACED into the function bundle. The loader reads
  //      it through a dynamic path, which static analysis cannot see, so
  //      without this the file is simply absent at runtime.
  //
  // Inert for every route that does not import the evaluator, and the tracing
  // entry is a no-op until an /api route does.
  serverExternalPackages: ["stockfish"],
  outputFileTracingIncludes: {
    "/api/**": [
      "node_modules/stockfish/src/stockfish-nnue-16-single.js",
      "node_modules/stockfish/src/stockfish-nnue-16-single.wasm",
    ],
  },

  // …and the package ships ~87 MB of things the engine never touches. Being an
  // external package, Next traces it whole; this trims it to the two files the
  // single-threaded build actually loads (measured: 87.3 MB → ~0.6 MB).
  //
  //   - *.nnue (83.8 MB): the NNUE nets. This build defaults to
  //     "option name Use NNUE value false", so no net is ever read — verified
  //     by running an evaluation from a directory containing only the js+wasm.
  //   - the other three WASM builds (multi-threaded / no-SIMD / no-Worker) and
  //     their loaders: unusable in serverless anyway (they need
  //     SharedArrayBuffer or nested workers).
  //   - the Emscripten/C++ sources, headers and Syzygy sources: build-time
  //     inputs, not runtime assets.
  outputFileTracingExcludes: {
    "/api/**": [
      "node_modules/**/*.nnue",
      "node_modules/stockfish/src/stockfish-nnue-16.js",
      "node_modules/stockfish/src/stockfish-nnue-16.wasm",
      "node_modules/stockfish/src/stockfish-nnue-16-no-Worker.js",
      "node_modules/stockfish/src/stockfish-nnue-16-no-Worker.wasm",
      "node_modules/stockfish/src/stockfish-nnue-16-no-simd.js",
      "node_modules/stockfish/src/stockfish-nnue-16-no-simd.wasm",
      "node_modules/stockfish/src/emscripten/**",
      "node_modules/stockfish/src/nnue/**",
      "node_modules/stockfish/src/incbin/**",
      "node_modules/stockfish/src/syzygy/**",
    ],
  },

  env: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  },

  // ── /games/* routing ─────────────────────────────────────────────────
  //
  // Two DIFFERENT things live under /games now, and they are dispatched
  // separately:
  //
  //   /games/<slug>       the PUBLIC, indexable landing page — a real App
  //                       Router route (src/app/games/[slug]/page.tsx). It is
  //                       deliberately NOT rewritten; the filesystem owns it.
  //   /games/<slug>/play  the AUTHENTICATED lobby, rewritten to the existing
  //                       /casino/<slug> route so the game application is
  //                       completely untouched.
  //
  // These rules are in `beforeFiles`, not the default `afterFiles`, and the
  // blanket `/games/:path*` catch-all is gone. That is the load-bearing part of
  // this refactor, learned from a real run: left as an `afterFiles` rewrite, the
  // blanket rule kept winning for /games/<slug> and served the LOBBY at the
  // landing-page URL (a visitor saw the game application with the wrong
  // canonical, and the new page was never reached at all). Enumerating the
  // sub-path shapes explicitly puts the split under our control:
  //
  //   * `/games` exact — the games hub, which is still the /casino index.
  //   * `/games/:slug/play` — the lobby. Declared before the sub-path rule
  //     below, which would otherwise rewrite "<slug>/play" to the non-existent
  //     /casino/<slug>/play (every game's lobby is /casino/<slug> itself).
  //   * `/games/:slug/:path+` — every deep game route (/games/chess/ai,
  //     /games/keno-pvp/<id>, /games/uno/game/<id> …), one or more segments.
  //
  // Anything else under /games (an unknown slug, a typo) now reaches the
  // landing-page route and 404s there, instead of being rewritten into a
  // non-existent /casino path.
  async rewrites() {
    const gameRewrites = [
      {
        source: "/games",
        destination: "/casino",
      },
      {
        source: "/games/:slug/play",
        destination: "/casino/:slug",
      },
      {
        source: "/games/:slug/:path+",
        destination: "/casino/:slug/:path+",
      },
    ];

    // Proxy PostHog ingestion through the app domain to prevent ad-blockers
    // from blocking analytics requests. The /ingest path must match the
    // api_host set in PostHogProvider.tsx (production only — dev talks to
    // PostHog directly so external DNS failures never spam the dev server).
    const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://app.posthog.com";
    const afterFiles = [];

    if (process.env.NODE_ENV === "production") {
      afterFiles.push({
        source: "/ingest/:path*",
        destination: `${posthogHost}/:path*`,
      });
    }

    return { beforeFiles: gameRewrites, afterFiles };
  },

  async redirects() {
    return [
      // The GRYND Shop is gone — there is no token currency and no catalogue.
      // The only paid product is the GRYND PRO membership, so the legacy Shop
      // URL permanently redirects to its new upgrade experience (old emails,
      // bookmarks and Stripe return URLs included). Config-level 308, per the
      // legacy-game-URL precedent above: a page-level redirect() would answer
      // 200 with a soft client redirect that crawlers re-fetch forever.
      {
        source: "/shop",
        destination: "/upgrade-pro",
        permanent: true,
      },
      // Legacy yahtzee URLs (both old and new prefix) land on Barricade — the
      // game that replaced it in the catalogue.
      {
        source: "/casino/yahtzee",
        destination: "/games/barricade",
        permanent: true,
      },
      {
        source: "/casino/yahtzee/:path*",
        destination: "/games/barricade",
        permanent: true,
      },
      {
        source: "/games/yahtzee",
        destination: "/games/barricade",
        permanent: true,
      },
      {
        source: "/games/yahtzee/:path*",
        destination: "/games/barricade",
        permanent: true,
      },
      // Dice Flush is retired from the catalogue: its public landing page and
      // its authenticated play page both land on Barricade, each keeping its
      // own prefix (the same shape the Dice Duel → Tower Arena cutover uses,
      // and the :path* variants carry deep links such as
      // /games/dice-flush/rules). No source listed here is also a destination
      // of another rule, so these cannot loop. The Dice Flush API routes and
      // database tables are deliberately left in place.
      {
        source: "/games/dice-flush",
        destination: "/games/barricade",
        permanent: true,
      },
      {
        source: "/games/dice-flush/:path*",
        destination: "/games/barricade",
        permanent: true,
      },
      {
        source: "/casino/dice-flush",
        destination: "/casino/barricade",
        permanent: true,
      },
      {
        source: "/casino/dice-flush/:path*",
        destination: "/casino/barricade",
        permanent: true,
      },
      // Legacy Dice Duel URLs now land on Tower Arena (its successor).
      {
        source: "/casino/dice-duel",
        destination: "/casino/tower-arena",
        permanent: true,
      },
      {
        source: "/casino/dice-duel/:path*",
        destination: "/casino/tower-arena",
        permanent: true,
      },
      {
        source: "/games/dice-duel",
        destination: "/games/tower-arena",
        permanent: true,
      },
      {
        source: "/games/dice-duel/:path*",
        destination: "/games/tower-arena",
        permanent: true,
      },
      // Legacy Connect Four URLs now land on Four-In-A-Row (its renamed successor).
      {
        source: "/casino/connect-four",
        destination: "/casino/four-in-a-row",
        permanent: true,
      },
      {
        source: "/casino/connect-four/:path*",
        destination: "/casino/four-in-a-row/:path*",
        permanent: true,
      },
      {
        source: "/games/connect-four",
        destination: "/games/four-in-a-row",
        permanent: true,
      },
      {
        source: "/games/connect-four/:path*",
        destination: "/games/four-in-a-row/:path*",
        permanent: true,
      },
      // Old /casino/* links keep working — bounce them to the new /games/* URLs.
      // Same exact-rule-first pattern as the rewrite above: bare /casino must
      // redirect to /games, not /games/ (which would 308-loop into the
      // rewrite and 404 the tree-prefetch).
      {
        source: "/casino",
        destination: "/games",
        permanent: true,
      },
      {
        source: "/casino/:path*",
        destination: "/games/:path*",
        permanent: true,
      },
    ];
  },

  async headers() {
    const securityHeaders = [
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=()"
      }
    ];

    if (process.env.NODE_ENV === "production") {
      securityHeaders.push({
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains; preload"
      });
    }

    return [
      {
        source: "/:path*",
        headers: securityHeaders
      },
      // The Monetag service-worker file. Two things have to be true for the
      // network's tag to be able to install it:
      //
      //   * the file must be reachable at the site ROOT (/sw1.js) — a service
      //     worker's scope is its own directory, so this is the only path that
      //     gives it the root scope the network's push/vignette formats expect;
      //     public/sw1.js is what serves it (a copy at the repo root would never
      //     be served at all — the same trap the old root sw.js fell into).
      //   * it must NOT be cached, or a worker update can be pinned to a stale
      //     revision for hours. `no-store` is the safe answer for a 156-byte
      //     file the browser fetches once per update check.
      //
      // `Service-Worker-Allowed: /` states the root scope explicitly rather than
      // relying on the script's own location. It is not a permission grant we
      // control — the browser still decides whether the network's tag may
      // register — it just keeps the served file honest about its scope.
      {
        source: "/sw1.js",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Service-Worker-Allowed", value: "/" }
        ]
      }
    ];
  }
};

module.exports = withPWA(nextConfig);

// Injected content via Sentry wizard below

const { withSentryConfig } = require("@sentry/nextjs");

module.exports = withSentryConfig(module.exports, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "grynd",
  project: "javascript-nextjs",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
