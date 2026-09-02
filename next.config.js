const withPWA = require("next-pwa")({
  dest: "public",
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === "development"
});

/** @type {import('next').NextConfig} */
const nextConfig = {
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

  env: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  },

  async rewrites() {
    // Proxy PostHog ingestion through the app domain to prevent ad-blockers
    // from blocking analytics requests. The /ingest path must match the
    // api_host set in PostHogProvider.tsx.
    const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://app.posthog.com";
    return [
      {
        source: "/ingest/:path*",
        destination: `${posthogHost}/:path*`,
      },
      // /games/* is the canonical alias for the game hub. It rewrites to the
      // existing /casino/* routes so the app code stays untouched while
      // /games URLs serve the same pages (and stay in the address bar).
      // Bare /games is handled by its own exact rule: an empty catch-all
      // (/games/:path*) rewrites to /casino/ on Vercel, and Next 16's
      // segment tree-prefetch can't match the trailing slash — it 404s the
      // _rsc prefetch of /games.
      {
        source: "/games",
        destination: "/casino",
      },
      {
        source: "/games/:path*",
        destination: "/casino/:path*",
      },
    ];
  },

  async redirects() {
    return [
      // Legacy solo Crash URLs. The old page-level redirect() only fired at
      // render time, so /games/crash (rewritten to /casino/crash) answered
      // 200 "Crash | GRYND" and client-navigated away — a soft redirect that
      // crawlers re-fetch forever. Config-level 308s fix that. `/games/crash`
      // must be listed BEFORE the /casino/:path* catch-all so it matches.
      {
        source: "/games/crash",
        destination: "/games/crash-arena",
        permanent: true,
      },
      {
        source: "/casino/crash",
        destination: "/games/crash-arena",
        permanent: true,
      },
      // Legacy yahtzee URLs (both old and new prefix) land on Dice Flush.
      {
        source: "/casino/yahtzee",
        destination: "/games/dice-flush",
        permanent: true,
      },
      {
        source: "/casino/yahtzee/:path*",
        destination: "/games/dice-flush",
        permanent: true,
      },
      {
        source: "/games/yahtzee",
        destination: "/games/dice-flush",
        permanent: true,
      },
      {
        source: "/games/yahtzee/:path*",
        destination: "/games/dice-flush",
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
