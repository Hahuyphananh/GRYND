import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// OpenNext adapter configuration for Cloudflare Workers.
//
// Phase 1 uses the defaults on purpose: the incremental cache, tag cache and
// revalidation queue all resolve to `dummy`, so no R2 bucket / self-reference
// service binding is required yet. Caching (R2 + Durable Objects) is a later
// phase, added only once the app actually runs on Workers.
//
// See https://opennext.js.org/cloudflare/caching for the caching overrides.
export default defineCloudflareConfig();
