---
name: bootstrapping-design-context
description: Use before any other UX/UI skill in a repo that has no design-context docs — no design brief, design tokens, or interaction-system doc present.
---
<!-- type: rigid -->

## Doctrine

**This skill runs exactly once per repo, first, before every other skill in this set.** `grounding-before-designing`, `flow-doc-first`, `designing-states-not-screens`, `anti-slop-audit` and the rest all cite the design-context docs as their source of truth. If those docs are absent, every downstream skill is operating on nothing and will hard-fail or, worse, invent. There is no "skip the bootstrap and start designing" path. Absence of the docs is the precondition that triggers this skill; presence of the docs is the only exit.

**The skill scaffolds *structure*; humans and the real codebase supply *content*.** The scaffolder writes empty, prompt-bearing templates: a design brief with section headings and interview questions, a tokens doc with a table to be filled from the actual stylesheet, an interaction-system doc with the categories to be observed. The skill's responsibility ends at the sentence "files created, now go interview the team and read the code." It does not, under any circumstance, continue past that sentence into authoring answers.

**The single largest failure mode is auto-filling the brief or tokens from training data or another project. This is forbidden.** This entire repository exists to kill two diseases in AI-built UI: *slop* (generic framework-default screens) and *fiction* (UI grounded in invented tokens, hallucinated components, a product the agent imagined). A hallucinated design brief is the most toxic possible artifact here, because it is upstream of everything: a fictitious brand adjective becomes a fictitious type scale becomes a fictitious component becomes a shipped screen that serves a product nobody is building. A README hint ("it's a coffee-trading platform"), domain familiarity, or a similar past client are not evidence — they are exactly the ungrounded sources this repo was built to refuse. A blank prompt that forces a human answer is strictly safer than a confident wrong one, because the blank prompt fails loudly and the wrong answer fails silently three skills downstream.

**This skill is idempotent and no-clobber.** It is always safe to re-run. The agent writes only files that are missing and reports `skipped (exists)` for every file already present, so it can never overwrite a human-filled doc. Re-running after a partial fill is the normal, expected path — not a risk.

**Hand-off is explicit.** After scaffolding and halting, the named next skill is `grounding-before-designing`. This skill does not itself ground, design, or audit; it only creates the slots those skills require and then stops.

## Process

The skill operates on six target-repo paths, each mapped to a template file in this skills repo:

| Target path (in consuming repo) | Source template (in this skills repo) |
|---|---|
| `docs/design-brief.md` | `templates/design-brief.md.tmpl` |
| `docs/design-tokens.md` | `templates/design-tokens.md.tmpl` |
| `docs/interaction-system.md` | `templates/interaction-system.md.tmpl` |
| `docs/ux-vocabulary.md` | `templates/ux-vocabulary.md.tmpl` |
| `docs/flow-doc-convention.md` | `templates/flow-doc-convention.md.tmpl` |
| `.claude/agents/design-system-steward.md` | `templates/design-system-steward.agent.md.tmpl` |

1. **Detect.** For each of the six target paths above, check existence in the consuming repo. Record each as `PRESENT` or `MISSING`. Do not infer presence from a README, a `theme.ts`, or memory — only the file-existence check counts.
2. **Decide.** If every file is `PRESENT`, this skill is already satisfied: state that and hand off to `grounding-before-designing`. If any file is `MISSING`, continue.
3. **Scaffold.** For each `MISSING` path: read the mapped template from this skills repo verbatim and write its full contents to the target path in the consuming repo, creating parent directories as needed. **No-clobber:** if a target file is `PRESENT`, do not touch it under any circumstance. Do not edit, "improve," or fill in template prompts while copying — copy bytes only.
4. **Report.** Print one line per path of the form `created: <path>` or `skipped (exists): <path>`, followed by a `N created, M skipped` summary. Do not paraphrase the counts.
5. **HALT and instruct the interview.** Stop here. State plainly that the six scaffolded files are now empty templates that MUST be filled by interviewing the team and reading the real codebase. Explicitly refuse to author their content yourself. Do not begin the requested UI work.
6. **Name the next step.** Tell the operator the next skill is `grounding-before-designing`, to be run only after the scaffolds are filled by humans.

## Red flags

| Rationalisation | Reality |
|---|---|
| "I'll just fill the brief from what I know about this domain." | That is the exact fiction this whole repo exists to prevent. Domain knowledge is not project evidence; an invented brief poisons every skill downstream of it. |
| "A brief sort of exists in the README, close enough." | Run `--detect`. The detector's `MISSING`/`PRESENT` output is the only authority; a README mention is not a design brief and assuming it is is precisely the ungrounded leap to refuse. |
| "The team is busy — I'll draft the tokens to save them time." | Invented tokens cascade into every component and screen. A blank prompt fails loudly now; a wrong token fails silently three skills later. The blank is the safer artifact. |
| "It's a tiny project, it doesn't really need a brief." | Small projects ship slop fastest because nothing constrains them. The brief is the cheapest guardrail that exists; skipping it on small work is where slop is most likely, not least. |
| "The scaffold ran but I'll keep going and design now." | The skill's contract ends at HALT. Continuing past the interview instruction is the failure this skill is defined to stop. Hand off to `grounding-before-designing` and stop. |
| "It already has a theme.ts, so the tokens doc must be fine to skip." | Code is not the doc. The tokens doc is filled *from* the code by a human who verified it; an unfilled scaffold next to a stylesheet is still unfilled. |
