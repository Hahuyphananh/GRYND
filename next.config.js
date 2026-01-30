/** @type {import('next').NextConfig} */
const nextConfig = {
  // experimental features
  experimental: {
    turbo: false, // keep Turbopack disabled if needed
  },
  webpack: (config) => {
    // keep your PDF.js fix intact
    config.externals = [...config.externals, { canvas: "canvas" }];
    return config;
  },
  env: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  },
};

module.exports = nextConfig;
