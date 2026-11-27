// tests/age-gate.test.mjs
//
// The 18+ rule has ONE decision point (src/lib/auth/requireAgeVerified.ts).
// These tests pin its outcomes, because the failure modes are asymmetric:
// a gate that lets an under-18 account through is the compliance bug, and a
// gate that rejects an eligible adult is a support incident.
//
// Run with: node --import tsx --test tests/age-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  ageGateFailureFor,
  getAgeGateMode,
} from "../src/lib/auth/requireAgeVerified.ts";
import { MINIMUM_AGE } from "../src/lib/ageVerification.ts";

test("an adult is allowed", () => {
  assert.equal(ageGateFailureFor(MINIMUM_AGE), null);
  assert.equal(ageGateFailureFor(MINIMUM_AGE + 40), null);
});

test("the day before the 18th birthday is rejected", () => {
  const failure = ageGateFailureFor(MINIMUM_AGE - 1);
  assert.equal(failure?.reason, "underage");
  assert.equal(failure?.status, 403);
  assert.match(failure?.error ?? "", /18/);
});

test("a missing date of birth is its own rejection, not a 401", () => {
  const failure = ageGateFailureFor(null);
  assert.equal(failure?.reason, "missing_age");
  assert.equal(failure?.status, 403);

  // A NaN/Infinity age must not slip through as "adult".
  assert.equal(ageGateFailureFor(Number.NaN)?.reason, "missing_age");
  assert.equal(ageGateFailureFor(Number.POSITIVE_INFINITY)?.reason, "missing_age");
});

test("a failed lookup fails CLOSED with a retryable status", () => {
  const failure = ageGateFailureFor(30, true);
  assert.equal(failure?.reason, "age_lookup_failed");
  assert.equal(failure?.status, 503, "an outage must never read as eligible");
});

test("the rollout mode defaults to enforce, and typos cannot relax it", () => {
  assert.equal(getAgeGateMode(), "enforce");

  const previous = process.env.API_AGE_GATE;
  try {
    process.env.API_AGE_GATE = "log";
    assert.equal(getAgeGateMode(), "log");

    process.env.API_AGE_GATE = "off";
    assert.equal(getAgeGateMode(), "off");

    process.env.API_AGE_GATE = "enforcedd";
    assert.equal(getAgeGateMode(), "enforce", "an unrecognised value must fail secure");
  } finally {
    if (previous === undefined) delete process.env.API_AGE_GATE;
    else process.env.API_AGE_GATE = previous;
  }
});
