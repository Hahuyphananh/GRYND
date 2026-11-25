# Flow Doc Convention

> This document defines the non-negotiable process for every piece of new UI in this project.
> It is generic — it applies regardless of the feature being built.

---

## The required order

Every new UI feature follows this sequence without exception:

### 1. Brainstorm

Understand the job-to-be-done before touching any UI tool. Answer:
- What is the user trying to accomplish?
- What state does the system need to be in for this to be possible?
- What happens if it goes wrong?
- What does success look like from the user's perspective?

Output: bullet notes. No artefact required, but the questions must be answered.

### 2. Write the flow doc

Produce a self-contained HTML document (or equivalent reviewable artefact) that contains:
- **Real styles** — tokens from `docs/design-tokens.md`, not invented values
- **Real-shape data** — representative values from the actual data model, not "Lorem ipsum" or "Sample Name"
- **ALL states** — default, loading, empty, error, success, edge cases. Every state the user can encounter.

The flow doc is the reviewable specification. It must be renderable in a browser and visually accurate enough that a non-engineer can review it.

> **Why this step exists:**
> A reviewable artefact must exist before production UI is built. Without it, bugs and misunderstandings are discovered in code review or production — the most expensive possible point. The flow doc moves that discovery to the cheapest possible point.

### 3. Human review of the rendered flow doc

A team member (product, design, or engineering) must open the rendered doc and confirm:
- All required states are present
- Copy matches the voice rules in `docs/design-brief.md`
- Actions match `docs/ux-vocabulary.md`
- The interaction patterns match `docs/interaction-system.md`

This step is not optional. "I described it in words" is not a review. The artefact must be rendered.

### 4. Spec

Write the implementation spec from the reviewed flow doc. The spec references the flow doc by path.

### 5. Plan

Break the spec into implementation tasks. Identify dependencies. Estimate.

### 6. Implementation

Build from the plan. Reference the flow doc when behaviour is ambiguous — the flow doc wins over the implementer's interpretation.

---

## What a process failure looks like

- Skipping step 2 and going straight to code → **process failure**
- Skipping step 3 (writing a flow doc nobody reviews) → **process failure**
- Reviewing the flow doc in spec form rather than rendered → **process failure**
- Using invented data or styles in the flow doc → **flow doc is invalid**, redo step 2

---

## Flow doc checklist

Before marking a flow doc ready for review (end of step 2), confirm:

- [ ] Renders correctly in a browser with no external dependencies
- [ ] Uses real token values (spacing, colour, type) from `docs/design-tokens.md`
- [ ] Every visible string uses copy from `docs/ux-vocabulary.md` or `docs/design-brief.md` (no Lorem ipsum)
- [ ] Default state is shown
- [ ] Loading state is shown
- [ ] Empty state is shown
- [ ] At least one error state is shown
- [ ] Destructive actions follow the severity rules in `docs/interaction-system.md`
- [ ] Focus order is logical when tabbing through the rendered doc
