# SKILL.md Authoring Conventions

This document is the authoritative checklist for authoring skills in this repository. The structural linter at `bin/lint_skills.py` enforces the machine-checkable rules. Rules marked **review-enforced** are checked by humans during code review, not by the linter.

---

## Relationship to superpowers:writing-skills

These conventions are the house adaptation of the `superpowers:writing-skills` meta-skill. They keep every binding rule from that skill — the frontmatter contract, the triggering-conditions-only description discipline, the falsifier-first (TDD) authoring workflow — while adding a fixed body structure (Doctrine / Process / Red flags) and a `<!-- type: rigid|flexible -->` classifier derived from the Matt Pocock / superpowers-skills style. Any future changes to `superpowers:writing-skills` binding rules must be reflected here.

---

## Rules

### R1 — Frontmatter fences

Every SKILL.md must begin with a YAML block fenced by `---` on its own line, followed by the content, followed by a closing `---` on its own line.

```
---
name: my-skill
description: Use when …
---
```

The total character count of the opening fence, YAML content, and closing fence (including newlines) must not exceed **1024 characters**.

### R2 — Required frontmatter fields

The frontmatter must contain exactly these two fields:

| Field | Constraint |
|---|---|
| `name` | Kebab-case (`[a-z0-9-]+`). Must exactly match the skill's directory name. |
| `description` | Must start with `Use when `, `Use before `, or `Use after `. Maximum 500 characters. |

No additional frontmatter fields are permitted.

### R3 — Description scope (review-enforced)

The `description` value must describe **triggering conditions and symptoms only**. It must **not** summarise the skill's process or workflow. The following pattern is a documented failure mode and must be rejected in review:

> "Use when X — scaffolds A, B, then does C."

Correct:

> "Use when you need to author a new SKILL.md and want to avoid common structural mistakes."

The linter checks the `Use when/before/after` prefix but cannot detect workflow-summarising prose. This rule is **review-enforced**.

### R4 — Type classifier comment

Immediately after the closing `---` frontmatter fence (before any heading), the file must contain one of:

```
<!-- type: rigid -->
```

or

```
<!-- type: flexible -->
```

`rigid` skills specify a mandatory sequence of steps. `flexible` skills specify heuristics or reference material where the author judges the order.

### R5 — Required body sections

The body must contain the following H2 headings, in this exact order, using these exact titles:

1. `## Doctrine`
2. `## Process`
3. `## Red flags`

No other H2 or H1 headings are required; additional H3s and below are permitted within each section.

### R6 — Red flags table

The `## Red flags` section must contain a markdown table with a header row that reads exactly:

```
| Rationalisation | Reality |
```

The table documents failure modes and self-deceptions (rationalisation column) alongside their ground truths (reality column). Every skill must have at least one row.

### R7 — No placeholder tokens

The following literal strings must not appear anywhere in a SKILL.md:

- `TODO`
- `TBD`
- `FIXME`
- `placeholder`

These indicate incomplete authoring. The linter treats their presence as a hard failure.

### R8 — Trailing newline

The file must end with exactly one trailing newline. Files ending with `\n\n` or more are invalid. Files with no trailing newline are invalid.

---

## House body structure (summary)

```
---
name: <kebab-case-name>            # matches directory name
description: Use when <conditions> # triggering conditions only, ≤500 chars
---
<!-- type: rigid|flexible -->

## Doctrine
<Non-negotiable principles that anchor the skill.>

## Process
<Ordered steps (rigid) or heuristics (flexible).>

## Red flags
| Rationalisation | Reality |
|---|---|
| <self-deception> | <ground truth> |
```

This structure intentionally specialises the generic `superpowers:writing-skills` template. The Doctrine / Process / Red flags tripartite body and the `type` classifier are house conventions; the frontmatter contract and the falsifier-first (TDD) authoring discipline come directly from the upstream meta-skill and are binding.
