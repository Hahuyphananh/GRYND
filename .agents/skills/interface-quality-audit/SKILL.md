---
name: interface-quality-audit
description: Audit existing frontend interfaces for design quality, usability, accessibility, and implementation risks. Use when Codex needs to review screenshots or source code, run static UI heuristics, identify layout and hierarchy problems, prioritize fixes, and produce a concrete repair plan.
---

# Interface Quality Audit

## Goal

Find the highest-leverage interface problems and turn them into actionable fixes. Lead with evidence, not taste declarations.

## Workflow

1. Inspect the rendered UI when possible. Use screenshots across desktop and mobile for visual work.
2. Inspect source files for implementation patterns that can create layout, accessibility, or polish regressions.
3. Run the static helper when a local project is available:

```bash
node skills/interface-quality-audit/scripts/static-ui-audit.mjs <project-path>
```

4. Score findings with `references/rubric.md`.
5. Report prioritized findings first, then a short repair plan.
6. If asked to fix the UI, implement the top issues and verify again.

## Finding Format

```text
P1/P2/P3 - Title
Evidence:
Impact:
Fix:
Verification:
```

## Severity

- P1: Blocks comprehension, task completion, accessibility, or release confidence.
- P2: Creates visible confusion, weak hierarchy, layout fragility, or repeated user friction.
- P3: Polish improvement with limited behavioral risk.

## Resources

- Use `scripts/static-ui-audit.mjs` for a quick source scan.
- Read `references/rubric.md` for review criteria.

