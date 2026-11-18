---
name: anti-slop-audit
description: Use when checking UI for generic, templated, or AI-slop tells, as a fast pre-PR check or within a deeper audit.
---
<!-- type: rigid -->

## Doctrine

**Slop is the default, not the exception. This checklist exists because generic, templated, AI-default output is exactly what you ship by NOT checking.** An unguided agent does not produce slop by accident — slop is the centre of its distribution: framework chrome, centred everything, lorem ipsum, one type size, no states. The whole reason this skill exists is that the un-audited path lands there every time. The audited path is the only path that does not. So this skill is not optional polish run at the end; it is the guardrail that names the default and refuses it.

**The checklist is run item by item. "Looks fine" is not the output of this skill.** The output is a per-item verdict — each of the eleven items below either passes silently or is flagged with the offending element quoted. A holistic glance ("this looks pretty clean", "nothing generic jumped out") is precisely the failure this skill kills, the same way `grilling-ui` kills the glance: the absence of per-item results means the checklist was not run, not that the screen is clean. You ran this skill only if there is an item-by-item pass.

**The eleven items — each a checkable yes/no with its anchor.** Run every one, in order:

1. **Framework-default look** — unmodified Bootstrap / Material / Tailwind-default chrome (default button, default card, default font stack). The canonical slop tell. Anchor: `nielsen-heuristics.md` H8 (unmodified framework chrome is undifferentiated default no one deliberately chose — extra units competing with no signal, not a deliberately chosen system).
2. **No visual hierarchy** — title, labels, body, action all one size-weight; nothing leads the eye. Anchor: `nielsen-heuristics.md` H8. Fix owner: `visual-hierarchy-and-type`.
3. **Centred-everything / no alignment grid** — every element horizontally centred with no deliberate edge or grid.
4. **Lorem ipsum / unrealistic-shape filler data** — "Lorem ipsum…", "Item 1 / Item 2", names and amounts that cannot occur in the real domain. Anchor: realism — design against real-shape data.
5. **Missing empty / error states** — a list/region that has no empty-state and no error-state rendering (only the happy path). Scope: existence of empty / error states for a region — NOT async-action loading affordance, which is item 10's sole lane; never flag the same loading defect under both 5 and 10. Anchor: `nielsen-heuristics.md` H1. Fix owner (state existence): `designing-states-not-screens`.
6. **Hover-only interactions** — interactivity revealed only on `:hover`, no focus/keyboard/touch equivalent. Anchor: `nielsen-heuristics.md` H6 / accessibility.
7. **Off-scale spacing** — padding/margin values not on the project's real spacing scale. Anchor: ties to `grounding-before-designing` (the real scale).
8. **Invented tokens/classes** — a class or token not in the real system (`btn-primary`, `var(--space-3)` when neither exists). The fiction tell. Anchor: ties to `grounding-before-designing`.
9. **Marketing-speak / fake-cheerful copy** — "Welcome aboard! 🎉", "Oops! Something went wrong" where plain task copy belongs. Fix owner: `precision-copy-and-formatting`.
10. **No loading affordance on async actions** — submit/fetch with no pending state. Anchor: `nielsen-heuristics.md` H1.
11. **Inconsistent interaction across surfaces** — the same action behaves differently in two places. Anchor: `nielsen-heuristics.md` H4.

**Anchor by reference, never from memory.** Where an item carries a Nielsen anchor (H4, H6, H8, H1), the flag cites the exact reference via `design-judgment-references` (`nielsen-heuristics.md` H<n>) — do not paraphrase the heuristic from training data. A flag whose cited heuristic does not actually govern the quoted element is decorative anchoring, the same failure `grilling-ui` and `design-judgment-references` forbid.

**Lane discipline: this skill DETECTS, it does not FIX.** The positive fix lives elsewhere — hierarchy in `visual-hierarchy-and-type`, state existence in `designing-states-not-screens`, copy in `precision-copy-and-formatting`, real tokens/classes in `grounding-before-designing`. For every flag, name the owning skill and stop. Fixing here is scope creep and silently couples detection to a fix this skill does not own.

**No false positives. A flag on a screen that does not exhibit the tell is noise that trains dismissal.** Each flag must cite the specific offending element — quoted markup, the literal copy string, the raw spacing value — mirroring `grilling-ui`'s verbatim-quote rule. An item that does not apply passes silently; a clean screen produces zero findings. Flagging "everything that could be improved" is not thoroughness — it is the noise that makes the next reader ignore the real flags.

**Two modes, one checklist.** (1) **Standalone** — a fast pre-PR check: run the eleven items against the changed surface before opening the PR. (2) **Sub-routine** — invoked by `grilling-ui` inside its element-by-element clear-attempt loop; this checklist is the slop pass of that grill, not a thing the grill re-invents or eyeballs. Same items, same anchoring discipline, in both modes.

## Process

1. **Take the target surface.** Standalone: the changed UI for the PR. Sub-routine: the element/surface `grilling-ui` is currently clearing.
2. **Run each item in order, yes/no.** Walk items 1–11. For each, decide: does this tell appear on the surface? If no, the item passes silently. If yes, it is a flag — quote the specific offending element verbatim (the markup, the copy string, the raw value).
3. **Anchor each flag.** Where the item carries a Nielsen anchor, cite it via `design-judgment-references` (`nielsen-heuristics.md` H<n>) with the one-line why this heuristic condemns this quoted element. Items without a heuristic anchor (centred-everything, lorem ipsum, off-scale, invented token) carry their stated anchor (realism / grounding fiction tell).
4. **Name the owning skill for each flag.** Hierarchy → `visual-hierarchy-and-type`; state existence → `designing-states-not-screens`; copy → `precision-copy-and-formatting`; real tokens/classes & off-scale spacing → `grounding-before-designing`. Do not perform the fix here.
5. **Emit per-item results.** Output: each flag as `item → quoted element → anchor → owning skill`. Items that did not apply are not listed (silent pass). A surface with zero tells emits an explicit "checklist run, no tells" — not a vibes "looks fine", and not invented flags to look thorough.

## Red flags

| Rationalisation | Reality |
|---|---|
| "It passes the vibe check, looks clean enough." | Vibes is not the check. The output of this skill is a per-item pass/flag over all eleven items. No item-by-item pass means you did not run this skill — you glanced, which is the exact failure it exists to kill. |
| "I'll just flag everything that could be improved, to be thorough." | False positives are noise that trains the reader to dismiss flags. Flag only tells actually present and quote the offending element. A clean screen passes silently — zero findings is a valid, correct output. |
| "I'll flag the slop and fix it here too while I'm in here." | Detection is this skill's lane; the fix is owned elsewhere — `visual-hierarchy-and-type`, `designing-states-not-screens`, `precision-copy-and-formatting`, `grounding-before-designing`. Flag, name the owner, stop. Fixing here is scope creep. |
| "Bootstrap defaults are fine, it's an internal tool." | Framework-default chrome is the canonical slop tell — that is item 1. Internal is not exempt; slop is slop. The audience does not change what the default produces. |
| "I know Nielsen, I'll just say it violates minimalism." | Anchor by reference, not memory. Cite `nielsen-heuristics.md` H<n> via `design-judgment-references` with the why-line, or the flag is decorative anchoring — taste with a footnote, the same failure `grilling-ui` forbids. |
| "Nothing generic jumped out, so there's nothing to report." | "Nothing jumped out" is the glance. The default an unguided surface ships IS slop; if the checklist genuinely cleared all eleven, say so explicitly per item — the absence of a recorded pass is the defect, not the all-clear. |
