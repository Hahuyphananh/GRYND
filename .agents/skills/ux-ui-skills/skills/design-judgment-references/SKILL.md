---
name: design-judgment-references
description: Use when making or defending a UI quality judgment, or when a critique or design decision needs to be anchored to an established principle rather than personal taste.
---
<!-- type: flexible -->

## Doctrine

**A UI quality judgment cites a named principle from `references/`, or it is not a finding yet.** "Looks off", "feels cluttered", "isn't clean", "not professional", "seems cramped" are *symptoms*, not findings. A symptom becomes a finding only when it is anchored to a specific, named principle in this skill's `references/` directory — naming the exact file and the exact principle within it. Until then it is taste, and taste is not actionable, not defensible, and not reviewable. This skill exists so that every quality call in the pipeline rests on a real, named methodology instead of vibes. It is the anti-fiction guardrail at the *judgment* level — the sibling of `grounding-before-designing`, which is the same guardrail at the data/component level.

**The five sources, and exactly when each applies.** Match the symptom to the right reference before citing:

- **`nielsen-heuristics.md`** — the usability *floor*. Anything about feedback/system status, error handling, consistency, memory load, clutter, control/undo. Cite the heuristic *number* (H1–H10). Clutter/"too much" → almost always **H8**; "rendered three different ways" → **H4**; "have to remember it" → **H6**.
- **`atlassian-systems.md`** — system cohesion: tokens vs magic numbers, type/colour scale, iconography consistency, accessibility as a baseline. "This should be a token, not a one-off value" lives here.
- **`linear-method.md`** — the craft/quality bar and posture: missing opinionated defaults (death by configuration), designing for the wrong user, latency treated as out of scope, "good enough, ship it".
- **`rauno-craft.md`** — interaction polish: motion that explains nothing, missing states (hover/focus/active/disabled/loading/empty/error), incoherent depth/layering, a generic input where a precise constrained control belongs.
- **`atomic-design.md`** — composition/structure: logic at the wrong level (organism stuffed in an atom), a fix patched at the page level that belongs in the atom, a design validated only as a template and never as a populated real-content page.

**This skill is cited *by* `grilling-ui` and `anti-slop-audit`; an unanchored finding from those skills is itself a process failure.** When those skills surface a problem, the problem is not delivered until it carries a named anchor from here. A `grilling-ui` or `anti-slop-audit` output that says "this feels generic" with no cited principle has not done its job — the missing anchor is a defect in *that* run, not a stylistic preference of the reviewer. Push it back.

**This is a reference to reason *with*, not a procedure to march through.** It is flexible by design: there is no fixed order, no mandatory step sequence, you pick the source the symptom points to. Exactly one rule is non-negotiable and overrides the flexibility: **no quality judgment ships without a specific named principle behind it.** "Cite a real, specific anchor" is absolute; everything else about how you get there is judgment.

**Specificity is part of the anchor.** "Nielsen says so" is not anchored — Nielsen has ten heuristics and the number carries the argument. "It violates Atlassian" is not anchored — name the principle. A source cited without its specific principle is the same failure as no citation: it only *looks* grounded. And taste dressed as consensus ("everyone knows this is bad", "this is obviously unprofessional") is still taste — consensus is not a `references/` file.

## Process

This is lightweight because the skill is a reference, not a pipeline.

1. **Capture the raw symptom.** State the vague reaction verbatim ("the panel looks cluttered"). Do not yet treat it as a finding.
2. **Match it to a source.** Use the five-source map in Doctrine to pick the reference the symptom points to. Clutter/excess → Nielsen H8; inconsistency → Nielsen H4 or Atlassian; token/scale/a11y → Atlassian; defaults/quality/latency → Linear; motion/states/depth/input precision → Rauno; wrong composition level / template-only validation → Atomic Design.
3. **Cite the exact file and principle.** Name the source file in `references/` and the specific principle within it (the heuristic *number*, the named principle, the named concept). Generic citation is not citation.
4. **Restate the fix in that principle's terms.** Translate "make it cleaner" into the principle's language: e.g. "remove the two decorative panels carrying no information — H8: every extra unit competes with the relevant ones."
5. **If you think there's no principle, check Rauno and Atlassian before saying so.** Most "this is just aesthetic" calls have a named basis in interaction craft or system cohesion. "Unprincipled aesthetic" is a last resort that itself must be defended.

## Red flags

| Rationalisation | Reality |
|---|---|
| "It just looks unprofessional." | Unprofessional under *which* named principle? Anchor it to a specific entry in `references/` or it is not a finding — it is your taste with a confident tone. |
| "I'll cite Nielsen generally." | Nielsen has ten heuristics; the number is the argument. "Nielsen says so" is unanchored. Cite the specific H-number or you have not cited anything. |
| "This is obviously bad, everyone knows that." | Obvious to whom, by what named principle? Consensus is not a `references/` file. Taste dressed as consensus is still taste — name the principle. |
| "There's no principle for this, it's purely aesthetic." | Check Rauno and Atlassian before declaring it unprincipled. Motion, interaction states, depth, tokens, and cohesion cover almost every "pure aesthetic" call. "Unprincipled" is a last resort you must defend, not a default escape. |
| "`grilling-ui` already flagged it, that's enough." | An unanchored finding from `grilling-ui` or `anti-slop-audit` is a defect in *that* run. The flag is not delivered until it carries a named anchor from here. Push it back. |
| "It's a flexible skill, so I can skip the citation if it's clearly bad." | Flexible refers to order and approach, not to the one non-negotiable rule. "No judgment ships without a specific named principle" overrides the flexibility every time. |
