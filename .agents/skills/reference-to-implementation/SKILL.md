---
name: reference-to-implementation
description: Analyze screenshots, mockups, visual references, or brand examples and translate them into implementable frontend code without copying protected assets. Use when Codex needs to infer layout grammar, typography, spacing, components, responsive behavior, and verification steps from images or reference URLs.
---

# Reference To Implementation

## Boundary

Use references to infer design grammar. Do not copy logos, illustrations, proprietary assets, exact copy, or distinctive trade dress unless the user owns them or explicitly provides permission.

## Workflow

1. Inventory each reference with `references/analysis-template.md`.
2. Separate transferable patterns from protected specifics.
3. Create a local design grammar: layout, type, spacing, color roles, component shapes, imagery treatment, and motion cues.
4. Implement the UI using the repository's existing stack and component patterns.
5. Replace unavailable assets with user-provided media, generated originals, or honest placeholders that preserve layout without pretending to be the reference.
6. Verify the result in rendered form. Use browser screenshots when a local app is available.

## Transferable Patterns

- Information hierarchy.
- Relative density.
- Spacing rhythm.
- Navigation placement.
- Component anatomy.
- State behavior.
- Image aspect ratios and cropping strategy.
- Tone of motion.

## Non-Transferable Specifics

- Logos and marks.
- Exact illustrations, photos, icons, and mascots.
- Exact marketing copy.
- Unique product names.
- Distinctive branded compositions that identify one company.

## Resources

- Use `references/analysis-template.md` to analyze inputs.
- Use `references/implementation-checklist.md` before finishing.

