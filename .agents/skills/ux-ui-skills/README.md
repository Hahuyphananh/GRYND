# ux-ui-skills

A standalone, distributable set of UX/UI skills for AI coding agents. Targets the two failure modes of AI-generated UI:

- **Slop** — generic, template-default, framework-boilerplate UI that looks like every other AI-built screen.
- **Fiction** — UI ungrounded in the project's real design system, with invented CSS classes, hallucinated tokens, and components that don't exist.

Each skill carries the *method* for producing Linear / Notion / Vercel / Stripe-tier UI in any codebase, not the answers for one project. Your tokens, components, and interaction vocabulary are scaffolded by the bootstrap skill and filled in once, then cited by every other skill from that point on.

## Install

### Claude Code (global)

```bash
git clone https://github.com/taylorwinfield/ux-ui-skills.git ~/.claude/skills/ux-ui-skills
```

### Claude Code (single project)

```bash
git clone https://github.com/taylorwinfield/ux-ui-skills.git .claude/skills/ux-ui-skills
```

### Other agents (Cursor, Windsurf, Copilot, Codex, Aider, Zed, Amp, Cline…)

Clone anywhere and point your agent's skill loader at the `skills/` directory. Each subdirectory is a self-contained skill with its own `SKILL.md`.

## How to use it

After installing, ask your agent things like:

```
/ux-ui-skills audit this screen for slop
```

```
/grounding-before-designing — am I about to invent a token?
```

```
/designing-states-not-screens for this list view
```

The agent loads the relevant skill and follows its method.

## Bootstrap into a project

If a target repo has no design brief / tokens / interaction-system doc, run the `bootstrapping-design-context` skill before any other skill in this set. The skill itself tells your agent which six files to scaffold from `templates/`, which paths to write them to, and to refuse to fill them in. Idempotent and no-clobber by contract — existing files are never touched.

No Python or other runtime is needed to use these skills. Everything is markdown and templates; the agent does the work.

## The skills

See [`SKILL.md`](SKILL.md) for the full index. Summary:

**Foundation (anti-fiction)**
- [`bootstrapping-design-context`](skills/bootstrapping-design-context/SKILL.md) — scaffolds the rest
- [`grounding-before-designing`](skills/grounding-before-designing/SKILL.md) — anti-fictitious core
- [`design-judgment-references`](skills/design-judgment-references/SKILL.md) — anchor judgments to established principle

**Feature design (create)**
- [`flow-doc-first`](skills/flow-doc-first/SKILL.md) — process spine
- [`designing-states-not-screens`](skills/designing-states-not-screens/SKILL.md) — the #1 slop→craft differentiator
- [`visual-hierarchy-and-type`](skills/visual-hierarchy-and-type/SKILL.md) — positive typographic craft
- [`interaction-craft`](skills/interaction-craft/SKILL.md) — Linear/Notion-tier motion + behavior
- [`precision-copy-and-formatting`](skills/precision-copy-and-formatting/SKILL.md) — microcopy, money, dates, destructive confirms

**Audit & refactor (grill)**
- [`grilling-ui`](skills/grilling-ui/SKILL.md) — grill-with-docs DNA applied to UI
- [`anti-slop-audit`](skills/anti-slop-audit/SKILL.md) — named anti-slop guardrail as an executable checklist

## Authoring conventions

Each `SKILL.md` follows a fixed structure:

- YAML frontmatter with `name` + `description` (must start with `Use when/before/after`)
- `<!-- type: rigid|flexible -->` classifier
- Sections in order: `## Doctrine` → `## Process` → `## Red flags`
- Red-flags table with header `| Rationalisation | Reality |`

Full rules in [`CONVENTIONS.md`](CONVENTIONS.md).

### Contributing

If you're authoring new skills against these conventions, a Python structural linter ships under `bin/lint_skills.py` (stdlib only, dev-time only — not needed to *use* the skills):

```bash
python bin/lint_skills.py skills/*/SKILL.md
python -m pytest tests/
```

## Licence

MIT. See [`LICENSE`](LICENSE).
