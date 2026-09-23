// tests/battlepass-page-contract.test.mjs
//
// Contract guard for how the battlepass page turns its fetched payload into
// the `pass` object the track renders from.
//
// The page can mount with NO cached payload (a first visit, where the fetch
// has not landed yet). Its AsyncState children are evaluated EAGERLY while
// PageClient renders — JSX is just a function call, so `{pass.prestigeUnlocked
// ? …}` is read even when AsyncState is about to render the skeleton. An
// unguarded track therefore threw:
//
//   TypeError: Cannot read properties of null (reading 'prestigeUnlocked')
//
// on the first render (the fetch starts in an effect, so it cannot have
// resolved yet) and the whole route fell into src/app/error.tsx — "This
// screen hit a problem". Deriving `pass` on the render path rather than
// seeding it from an effect is necessary but NOT sufficient: the children must
// also be guarded on `pass`, because AsyncState's state decision runs after
// the JSX has already been evaluated.
//
// qa/battlepass-reconnect-check.mjs mounts the real page and reproduces the
// crash; these static checks pin the derivation/guard contract. The AsyncState
// no-data fall-through and OfflineBanner's reconnect cache-write are hardened
// here too, for the same family of transient no-data windows.
//
// These are deliberately static checks: the page is a client component that
// needs Clerk, SWR and a live API, so this asserts the render CONTRACT rather
// than mounting it (the QA check above does the mounting).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PAGE = fileURLToPath(
  new URL("../src/app/battlepass/PageClient.jsx", import.meta.url),
);

const ASYNC_STATE = fileURLToPath(
  new URL("../src/components/states/AsyncState.tsx", import.meta.url),
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

test("the track JSX is guarded on `pass` so it is never evaluated against null", () => {
  const src = pageSource();

  // The fix that actually matters. AsyncState only decides WHAT to render;
  // its children are evaluated while PageClient renders, so the guard has to
  // live at the call site. The children expression must be `{pass ? (…` and
  // the first dereference inside it.
  assert.match(
    src,
    /hasData=\{Boolean\(pass\)\}[\s\S]{0,2000}?\{pass \? \([\s\S]{0,600}?pass\.prestigeUnlocked/,
    "the AsyncState children must be wrapped in `{pass ? (…) : null}`; they are evaluated eagerly even when AsyncState shows a skeleton",
  );
});

test("AsyncState never renders data-bound children without a payload", () => {
  const src = readFileSync(ASYNC_STATE, "utf8");

  // Hardening for the same family of transient no-data windows: with no data
  // and no error, AsyncState must render a state (skeleton) rather than
  // falling through to `children`, which assume a payload. The `!hasData`
  // branch must therefore terminate in a rendered state.
  const noDataBranch = src.match(/if \(!hasData\) \{[\s\S]*?\n  \}/);
  assert.ok(noDataBranch, "AsyncState must keep an explicit `!hasData` branch");
  assert.match(
    noDataBranch[0],
    /skeleton \?\? <DefaultSkeleton \/>/,
    "with no data and no error, AsyncState must show the skeleton rather than falling through to children",
  );
});

test("the reconnect revalidation does not wipe cached payloads", () => {
  const src = readFileSync(
    fileURLToPath(
      new URL("../src/components/states/OfflineBanner.tsx", import.meta.url),
    ),
    "utf8",
  );

  // Hardening for the transient no-data window: passing `undefined` as
  // mutate()'s second argument makes it a cache WRITE — SWR sets every matched
  // entry's data to undefined before the refetch restarts. Reconnect must use
  // the revalidate-only form and leave cached data in place.
  assert.doesNotMatch(
    src,
    /mutate\(\(\)\s*=>\s*true,\s*undefined/,
    "reconnect must revalidate in place, not write `undefined` over every cached payload",
  );
  assert.match(
    src,
    /mutate\(\(\)\s*=>\s*true\)/,
    "reconnect must call the revalidate-only mutate form",
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
