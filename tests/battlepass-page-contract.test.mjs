// tests/battlepass-page-contract.test.mjs
//
// Contract guard for how the battlepass page turns its fetched payload into
// the `pass` object the track renders from.
//
// Regression: the page fetched /api/battlepass through `useApiResource` but
// rendered from a second, effect-seeded copy of the payload:
//
//   const [pass, setPass] = useState(null);
//   useEffect(() => { if (resource.data?.pass) setPass(resource.data.pass); }, [resource.data]);
//   <AsyncState hasData={Boolean(pass)} ...>
//
// An effect only runs AFTER the render that received the payload, so there
// was always one render where `isLoading` was already false, `pass` was still
// null and `error` was undefined. <AsyncState> falls through to its children
// in that combination, the track read `pass.levels` off null, and the thrown
// TypeError bubbled to src/app/error.tsx — the whole screen showed
// "This screen hit a problem".
//
// The page must therefore derive `pass` from the resource payload on the
// render path (with the local claim mirror layered on top), so it is never
// null once data exists.
//
// These are deliberately static checks: the page is a client component that
// needs Clerk, SWR and a live API, so this asserts the data-derivation
// CONTRACT rather than mounting it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PAGE = fileURLToPath(
  new URL("../src/app/battlepass/PageClient.jsx", import.meta.url),
);

function pageSource() {
  return readFileSync(PAGE, "utf8");
}

test("the battlepass page renders from the fetched pass, not a lagging state copy", () => {
  const src = pageSource();

  // `pass` must fall back to the resource payload in the render expression
  // itself — that is what makes it available in the same render the data
  // lands in, instead of one render later via an effect.
  assert.match(
    src,
    /const pass\s*=\s*[^;]*resource\.data\?\.pass/,
    "`pass` must be derived from resource.data?.pass on the render path; a state-only copy lags by one render and crashes the track",
  );
});

test("AsyncState's hasData tracks the pass that is actually rendered", () => {
  const src = pageSource();

  assert.match(
    src,
    /hasData=\{Boolean\(pass\)\}/,
    "AsyncState must be told whether the rendered pass exists",
  );

  // Guard the exact shape of the bug: seeding `pass` solely from an effect.
  assert.doesNotMatch(
    src,
    /const\s*\{\s*[\s\S]{0,80}?\}\s*=\s*useApiResource[\s\S]{0,400}?const\s*\[\s*pass\s*,\s*setPass\s*\]\s*=\s*useState/,
    "`pass` must not be a plain useState mirror of the payload (the regression shape)",
  );
});

test("an arriving payload still overwrites the local claim mirror", () => {
  const src = pageSource();

  // Claims update the pass in place to avoid a refetch re-centering the
  // track, but a fresh server payload stays authoritative.
  assert.match(
    src,
    /useEffect\(\(\)\s*=>\s*\{\s*if \(resource\.data\?\.pass\) setClaimedPass\(resource\.data\.pass\);\s*\},\s*\[resource\.data\]\);/,
    "a new payload must reset the local claim mirror so refreshes win",
  );
});
