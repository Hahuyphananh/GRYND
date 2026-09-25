// tests/ad-slot-gate.test.mjs
//
// Behavioural test for the ad gate — drives the REAL AdSlot and the REAL
// AdSenseScript through every branch with the ad configuration and the
// membership answer mocked.
//
// The two properties this protects are the two that fail silently in
// production:
//
//   * a GRYND PRO member must receive NOTHING — no `<ins>`, no loader, no ad
//     request. Asserted for both surfaces, because "we hid it with CSS" and
//     "we didn't load the tag" are very different outcomes.
//   * a placement with no configured ad-unit id must render nothing, so an
//     unconfigured deploy shows no ads instead of an invented slot id.
//
// Module mocking needs --experimental-test-module-mocks; without the flag the
// test skips instead of failing (repo convention).
//
// Run: npm run test:ads

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const MODULE_MOCKING_AVAILABLE = typeof mock?.module === "function";
const SKIP_REASON = MODULE_MOCKING_AVAILABLE
  ? false
  : "module mocking is off — run: npm run test:ads";

const PUBLISHER = "ca-pub-4903728316211815";
const REAL_SLOT = "1234567890";

test(
  "ads render for free viewers only, and only where a real unit is configured",
  { skip: SKIP_REASON },
  async (t) => {
    // Mutable world: the mocks read this, so ONE import of each component can
    // be exercised across every branch (a module can only be mocked once per
    // test, so the branches are data, not separate mocks).
    const world = {
      adFree: false,
      enabled: true,
      slot: REAL_SLOT,
      perPlacement: false,
      asked: [],
    };

    t.mock.module("../src/lib/adEntitlement.ts", {
      namedExports: { isAdFreeViewer: async () => world.adFree },
    });
    t.mock.module("../src/lib/ads.ts", {
      namedExports: {
        adsEnabled: () => world.enabled,
        adUnitId: (placement) => {
          world.asked.push(placement);
          if (world.perPlacement) return placement === "hub" ? REAL_SLOT : null;
          return world.slot;
        },
        adsensePublisherId: () => PUBLISHER,
        normalizePublisherId: (value) =>
          typeof value === "string" && value.startsWith("ca-pub-") ? value : null,
      },
    });

    const { default: AdSlot } = await import("../src/components/AdSlot.tsx");
    const { default: AdSenseScript } = await import(
      "../src/components/AdSenseScript.tsx"
    );

    // ── 1. Free viewer, configured unit → the ad block and the loader ──────
    const slot = await AdSlot({ placement: "home" });
    assert.ok(slot, "a free viewer with a configured unit must get a slot");
    assert.equal(slot.props["data-ad-placement"], "home");
    assert.equal(slot.props["aria-label"], "Advertisement");
    // The unit inside carries the CONFIGURED id, never a literal in source.
    const unit = slot.props.children[1];
    assert.equal(unit.props.slotId, REAL_SLOT);
    assert.equal(unit.props.placement, "home");

    const tag = await AdSenseScript();
    assert.ok(tag, "a free viewer must get the AdSense loader");
    assert.ok(
      String(tag.props.src).includes(`client=${PUBLISHER}`),
      "the loader must use the configured publisher",
    );

    // ── 2. GRYND PRO member → nothing at all, on both surfaces ────────────
    world.adFree = true;
    assert.equal(
      await AdSlot({ placement: "home" }),
      null,
      "a member must receive no ad slot",
    );
    assert.equal(
      await AdSenseScript(),
      null,
      "a member must receive no ad tag — no code, no ad requests",
    );

    // ── 3. Free viewer, but this placement has no unit configured ─────────
    world.adFree = false;
    world.slot = null;
    assert.equal(
      await AdSlot({ placement: "home" }),
      null,
      "an unconfigured placement must render nothing rather than a fake id",
    );

    // ── 4. Ads switched off entirely → nothing, even for a free viewer ────
    world.slot = REAL_SLOT;
    world.enabled = false;
    assert.equal(await AdSlot({ placement: "home" }), null);
    assert.equal(await AdSenseScript(), null);

    // ── 5. Placements are independent: each asks for its own unit id ──────
    world.enabled = true;
    world.perPlacement = true;
    assert.ok(
      await AdSlot({ placement: "hub" }),
      "the placement that has a unit must render",
    );
    assert.equal(
      await AdSlot({ placement: "profile" }),
      null,
      "a different placement must not borrow another placement's unit",
    );
    assert.ok(
      world.asked.includes("hub") && world.asked.includes("profile"),
      "each slot must look up its own placement's unit id",
    );
  },
);
