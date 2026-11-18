# Acceptance falsifier — designing-states-not-screens

## Scenario (input situation)

`flow-doc-first` has reached the point where the flow-doc artifact for a
new surface must show every state, and it has handed off to this skill to
enumerate them. The surface is a **"Recent submissions" table**: borrower
name, submission date, status, and a row action. The agent is handed a
design that shows the table with eight populated rows of realistic data —
the populated happy path — and nothing else, with the framing:

> "Here's the submissions table design. It's basically always got rows in
> it in practice, so this is the design — wire it up."

The surface can demonstrably be empty (a brand-new lender account has zero
submissions), can be loading (the list is fetched over the network), can
error (the fetch can fail), can be partial (rows stream in), can exceed
limits (a power lender with thousands of rows), differs first-run vs
returning, and can be viewed offline/stale.

## Required behaviour (must all hold)

1. The agent **REJECTS the happy-path-only design as incomplete** — it
   states explicitly that a view is not designed until each applicable
   state is designed, and that the populated table is a v0, not a v1.
2. It **enumerates each applicable state for THIS specific surface**:
   empty, loading (including skeleton), partial / streaming-incomplete
   (some data shown, more still arriving), error, edge/over-limit,
   first-run vs returning, offline/stale. Any state it omits must be
   justified as
   genuinely impossible for this surface, not merely unlikely. "Always has
   rows in practice" is explicitly rejected as such a justification.
3. It treats the **empty state as an onboarding moment** — the zero-
   submissions state teaches a first-time lender what this surface is and
   what to do next; it is not "hide the table" or a bare blank.
4. It **hands the copy and formatting of each state to
   `precision-copy-and-formatting`** rather than writing the final
   microcopy/number-formatting itself, while still owning the decision
   that each state exists and is designed.
5. It **verifies against Nielsen H1** (visibility of system status) via
   `design-judgment-references`: in every state the user can tell which
   state they are in.

## Falsifier (this run is a FAIL if)

The agent accepts the eight-row populated table as the finished design and
proceeds to wire-up/spec without enumerating the missing states for this
surface. Accepting "it's basically always populated in practice" as
sufficient reason to skip the empty/loading/error states is a FAIL.

It is ALSO a FAIL if the agent enumerates states but treats **empty as a
blank / "hide the section"** rather than as an onboarding moment.

It is ALSO a FAIL if the agent **silently drops an applicable state**
(e.g. omits offline/stale or over-limit without justifying it as
genuinely impossible for this surface).

It is ALSO a FAIL if the agent **writes the final microcopy or number
formatting for the error/empty states itself** instead of handing that to
`precision-copy-and-formatting`. It is EQUALLY a FAIL if the agent
**produces draft/provisional headline, body, or CTA strings for any
state** — however labelled ("provisional", "handoff hint", "for
reference") — instead of delegating the words: authoring the copy at all,
draft or final, usurps the copy skill, because the seam is content-
existence vs content-itself, not draft vs final. Conversely, it is a FAIL
if it cedes the decision that a state must exist to that copy skill.

PASS requires: explicit rejection of the happy-path-only design → a
per-surface enumeration of every applicable state (empty, loading
(including skeleton), partial / streaming-incomplete, error,
edge/over-limit, first-run vs returning, offline/stale) with each one
designed → empty designed as onboarding → copy/formatting of
each state explicitly delegated to `precision-copy-and-formatting` →
verified against Nielsen H1 via `design-judgment-references`.
