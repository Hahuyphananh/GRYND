// src/lib/dedupeFetch.js
//
// Share one in-flight response between callers that ask for the same thing at
// the same moment.
//
// WHY: the profile mounts three loaders that each keep a different slice of the
// SAME endpoint — loadTitles, loadVipTitles and loadStreakTitles all read
// /api/titles (src/app/profil/PageClient.jsx). They start in the same tick, so
// the browser sent the identical request three times. The route's Redis cache
// (CacheKeys.titles) keeps those from reaching Postgres, but not the three
// round trips; this collapses them into one.
//
// Deliberately narrow, in two ways:
//
//   * Only IN-FLIGHT requests are shared. The entry is dropped as soon as the
//     response settles, so a later call always revalidates. There is no TTL
//     cache here on purpose: the profile dispatches "titleUpdated" /
//     "profileUpdated" events that refetch immediately after an equip, and
//     serving those a still-cached response is exactly the bug a TTL would
//     introduce.
//
//   * The init object is part of the key, so a POST (or any differently
//     configured request) can never be satisfied by another caller's response.
//
// Returns { response, data } — the same shape callers already build by hand
// from `await fetch(...)` + `await response.json()`.
//
// Usage:
//   const { response, data } = await fetchDeduped("/api/titles", {
//     credentials: "include",
//   });
//   if (response.ok && data.success) { ... }

const inflight = new Map();

/**
 * Fetch `url`, reusing the in-flight request when an identical one is already
 * running. Rejects exactly as `fetch` would; the entry is released either way.
 */
export function fetchDeduped(url, init = undefined) {
  const key = `${init ? JSON.stringify(init) : ""}|${url}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  let request;
  request = (async () => {
    try {
      const response = await fetch(url, init);
      return { response, data: await response.json() };
    } finally {
      // Released inside the promise the callers await — not in a detached
      // continuation — so by the time anyone sees a result the entry is gone
      // and the next call revalidates. `request` is assigned before the first
      // `await` above can yield, so the identity check is safe. A rejection
      // releases the entry the same way.
      if (inflight.get(key) === request) inflight.delete(key);
    }
  })();

  inflight.set(key, request);
  return request;
}

/** Drop any in-flight entry for `url` (used by tests and by callers that know a
 *  write just invalidated what other callers are waiting on). */
export function releaseDeduped(url) {
  for (const key of inflight.keys()) {
    if (key.endsWith(`|${url}`)) inflight.delete(key);
  }
}
