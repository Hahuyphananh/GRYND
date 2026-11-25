---
name: shipshape-frontend
description: Run a final release-readiness pass on frontend work. Use when Codex needs to verify responsive layouts, keyboard flows, focus states, reduced motion, content fit, empty and error and loading states, build scripts, visual regressions, and basic accessibility before shipping.
---

# Shipshape Frontend

## Goal

Catch release-facing frontend issues while they are still cheap to fix.

## Workflow

1. Run the app's existing checks: build, lint, typecheck, and tests where available.
2. Run the helper script for static readiness signals:

```bash
node skills/shipshape-frontend/scripts/preflight-report.mjs <project-path>
```

3. Inspect rendered desktop and mobile views when a local app exists.
4. Check keyboard movement, focus states, reduced-motion behavior, loading, empty, error, and success states.
5. Fix the highest-risk issues, then rerun the checks that failed.
6. Report what was verified and what remains unverified.

## Preflight Areas

- Responsive layout at narrow, tablet, laptop, and wide desktop widths.
- Text fit in buttons, tabs, labels, cards, sidebars, and modals.
- Keyboard focus visibility and logical tab order.
- Icon-only controls with labels or tooltips.
- Forms with helper text, validation, and recovery.
- Reduced motion for animated surfaces.
- Realistic loading, empty, error, and success states.
- Build and package scripts.

## Resources

- Run `scripts/preflight-report.mjs` for a static summary.
- Read `references/release-checklist.md` for manual verification.

