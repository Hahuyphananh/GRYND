---
name: brief-to-interface
description: Convert rough product briefs, feature ideas, or vague app and site requests into a concrete interface direction before implementation. Use when Codex needs to infer users, jobs, layout strategy, visual language, density, motion, responsive priorities, and acceptance checks before building a frontend.
---

# Brief To Interface

## Operating Rule

Turn a fuzzy request into an interface operating model before writing UI code. Preserve the user's intent, but add the missing product and design decisions that an implementation needs.

## Workflow

1. Extract the product promise, primary user, repeated job, emotional pressure, and core artifact.
2. Choose a composition mode from `references/composition-modes.md` when the brief does not already imply one.
3. Create an Interface Compass Card using `references/interface-card.md`.
4. Translate the card into screen zones, primary actions, data hierarchy, interaction rhythm, and responsive priorities.
5. Define acceptance checks that can be verified in a browser or screenshot review.

## Output Shape

Return a compact implementation brief:

- Product intent in one sentence.
- Interface Compass Card.
- Screen map for the first one to three views.
- Visual system notes for type, color roles, spacing, density, and shape.
- Interaction notes for hover, focus, loading, empty, error, and success states.
- Responsive behavior for mobile, tablet, and desktop.
- Acceptance checks that make the work testable.

## Decision Biases

- Prefer concrete nouns over mood words.
- Make the primary artifact visible in the first viewport.
- Pick one signature interaction or layout move, then keep the rest disciplined.
- Do not invent decorative scenes when product data, objects, or workflows can carry the design.
- Ask a question only when the missing answer would change the product category or data model.

## Resources

- Read `references/interface-card.md` for the output template.
- Read `references/composition-modes.md` when choosing a layout strategy.

