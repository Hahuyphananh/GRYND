# ACCEPTANCE — grilling-ui

One concrete, failable falsifier. If the skill cannot survive this, it is not done.

## Scenario

Point the skill at an existing flow doc (or template). The doc has, among other
things, a settings panel that renders the same status in three different visual
treatments, a one-off `#3a7afe` hex on a button instead of the brand token, and
an action area the reviewer privately thinks "looks a bit dated".

## PASS — all of the following must hold

1. The output is a **ranked findings report** with explicit
   **Blocking / Should / Consider** tiers, not a flat list.
2. **Every shipped finding is anchored**: each cites either a specific named
   principle (the exact `design-judgment-references` reference file *and* the
   principle within it — e.g. `nielsen-heuristics.md` H4 for the
   three-treatments status; H8 for clutter) **or** a concrete brief/token
   violation (the brief line quoted, or the token named — e.g. "uses `#3a7afe`,
   brand token is `--color-action-primary`"), **and every anchor includes the
   one-line statement of why that specific principle condemns that specific
   quoted element** — the fit/why-line, not just a citation bolted on.
3. **Every finding carries a concrete fix** — the specific change to make, not
   "improve this" or "clean this up".
4. The unanchored candidate ("the action area looks a bit dated") is **either
   anchored to a named principle or explicitly discarded in the report** with a
   stated reason — it does NOT appear as a finding in any tier.

## FAIL — any one of these fails the skill

- A glance-level pass: "looks mostly fine, nothing major".
- Any unanchored finding shipped in the report (a finding with no named
  principle and no concrete brief/token violation — e.g. "feels cluttered",
  "looks dated", "could be cleaner" standing alone).
- Any shipped finding that carries an anchor which does not actually govern
  the quoted element — a real principle on the wrong defect (e.g. "looks
  dated → `rauno-craft.md` missing states" loosely bolted onto a taste
  reaction). A citation that does not fit, or that ships with no one-line
  statement of why that principle condemns that element, is decorative
  anchoring and fails exactly as a missing anchor does.
- Any finding with no fix attached.
- No ranking (a flat list of problems).
- The "looks a bit dated" item shipped as a finding without an anchor, or
  silently dropped with no explicit discard note.

This falsifier is failable: a run that emits "the panel feels cluttered and the
buttons look dated — tidy them up" with no tiers, no H-numbers, and no fixes
fails on four counts at once.
