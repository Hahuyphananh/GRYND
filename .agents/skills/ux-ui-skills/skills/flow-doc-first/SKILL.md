---
name: flow-doc-first
description: Use when any user-facing UI is requested — a new screen, template, component, or a non-trivial restyle of an existing surface.
---
<!-- type: rigid -->

## Doctrine

**The order is non-negotiable and explicit: brainstorm → flow doc → human review (rendered) → spec → plan → implementation.** All six, in that sequence, every time user-facing UI is produced or changed. This is the process spine of UI work, not a guideline to apply when convenient. You may not collapse, reorder, or skip a stage because the change feels small, the deadline feels tight, or the request feels clear. The stage that exists specifically to be skipped under pressure — "flow doc → human review" — is the one this skill exists to protect. If you find yourself about to touch a production template or stylesheet and a human has not yet reviewed a rendered flow doc, you are in the failure this skill names; stop.

**The flow doc is a real artifact, not a sketch or a description.** It is a standalone, rendered surface built from the project's REAL styles and components — the verified vocabulary produced by `grounding-before-designing`, never invented classes or "sensible default" styling. It is populated with realistic-shape data: real field names, real value lengths, real edge-case content — never lorem ipsum and never fake-shaped filler, because fake data hides exactly the layout failures the flow doc exists to expose. It shows EVERY state of the affected surface, not just the happy path. (Defer the precise enumeration of states to `designing-states-not-screens`, but the requirement is binding here: a flow doc that shows only one state is not a flow doc.) An artifact that fails any of these three properties — real styles, real-shape data, all states — is not a flow doc; it is a mockup that will pass review and ship broken.

**It GATES implementation; it is not implementation.** This skill's entire job is the handoff decision: it stands between the request and the production code and refuses to let UI through until a human has seen it rendered. It does not itself perform implementation — spec, plan, and the production edit are downstream concerns that begin only after the gate opens. The failure class this forecloses is precise: **UI ships that the human never saw or shaped.** Going straight from a worded request to a production diff means the first time anyone sees the actual rendered result is in production (or in a PR screenshot taken from already-written production code, which is the same failure wearing a disguise). The flow doc is the one cheap point to catch "that is not what I meant"; after this gate that correction costs a revert.

**"Tiny change" is not an exemption.** The smallest restyles are exactly where unseen regressions ship — a one-line spacing tweak, a colour swap, a moved button — because they feel too trivial to warrant review and so they bypass the only point a human would have caught the regression. The test is not "is the diff small?" It is **"will a human see a visual surface change?"** If yes, a reviewed flow doc is mandatory regardless of diff size. There is no line-count threshold below which UI may ship unseen.

**Gate position is fixed.** This skill requires `grounding-before-designing` to have already run — the flow doc must be built from verified real styles, components, and data shapes, not unverified vocabulary. This skill in turn precedes spec, plan, and implementation: nothing downstream may begin until the rendered flow doc is reviewed and approved. Run this, in this order, every time UI is produced or changed.

## Process

1. **Confirm grounding is done.** Verify `grounding-before-designing` has run and a verified-vocabulary list (real components, tokens, data shapes) exists for this surface. If it has not, stop and run it — you have nothing trustworthy to build the flow doc from.
2. **Brainstorm options.** Before building anything, explore the design space: layout options, state behaviours, edge cases, the realistic data the surface must hold. Do not jump to the first idea.
3. **Write the flow-doc artifact.** Produce a standalone rendered surface using ONLY the verified real styles/components, populated with realistic-shape data (real field names and value lengths, never lorem), showing EVERY state of the affected surface. This is a separate artifact, not an edit to any production template or stylesheet.
4. **Surface it for rendered human review.** Explicitly hand the flow doc to a human to open and review **rendered in a browser**. Say so plainly and wait. Described is not seen; do not assume the words were enough.
5. **Gate on approval only.** On approval, hand off downstream to spec → plan → implementation (the production edit begins there, not here). On any redirect or "that's not what I meant", iterate the flow-doc artifact and re-surface it — never start changing production code to chase feedback.

## Red flags

| Rationalisation | Reality |
|---|---|
| "It's a one-line change, a flow doc is overkill here." | The smallest restyles ship the most unseen regressions, precisely because they feel too small to review. The test is "does a human see a visual change?", not diff size. One line that changes a rendered surface needs a reviewed flow doc. |
| "I'll build it in the template and screenshot that as the flow doc." | Production code is not the artifact. The artifact precedes and gates the code; a screenshot of already-written production UI is the exact failure — UI the human never shaped — wearing a disguise. Build the standalone flow doc first. |
| "Lorem ipsum / filler text is fine for the mock." | Fake-shaped data hides the real layout failures — long names, empty fields, overflow, the error string that wraps to three lines. Realistic-shape data is the entire point of a flow doc; without it the doc certifies nothing. |
| "The user described the change clearly, they don't need to see it." | Described is not seen. Words underspecify UI — that is the whole reason this skill exists. "Clear" requests produce surprised users at review time constantly; the rendered artifact is the only thing that closes the gap. |
| "I'll just show the default state, the other states are obvious." | An all-states flow doc is mandatory; "obvious" states are where hover, disabled, loading, error, and empty regressions hide unreviewed. One-state artifacts are not flow docs. |
| "Grounding basically ran, the styles are probably right, I'll proceed." | "Probably right" means the flow doc is built on unverified vocabulary and will render broken in a way invisible until the human loads it. Confirm grounding produced a verified list before building the doc, not after. |
| "The human reviewed the spec text, that counts as review." | The gated review is of the rendered artifact in a browser, not of prose describing it. Reviewing words about the UI is the same miss as never reviewing it — the point is seeing it rendered. |
