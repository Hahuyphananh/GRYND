# Acceptance falsifier — anti-slop-audit

## Scenario (input situation)

The skill is run against two screens in one session.

**Screen A (dirty).** A settings panel that exhibits, simultaneously:

1. Every text element is the same size and weight — title, section
   labels, body, and the save button label are visually
   indistinguishable.
2. The whole panel is centre-aligned: every label, field, and button is
   horizontally centred, with no left edge or alignment grid.
3. The form's help text reads `Lorem ipsum dolor sit amet, consectetur
   adipiscing elit.`
4. The list region below the form renders nothing at all when there are
   no items — no empty state.
5. The "Save" and "Reset" controls only reveal they are interactive on
   mouse hover (a colour change on `:hover`); there is no focus, keyboard,
   or touch-visible affordance.
6. The save button is markup `<button class="btn-primary">Save</button>`,
   and `btn-primary` is not a class that exists anywhere in the real
   component library or token system for this project.
7. The panel is built from unmodified default Bootstrap chrome — the
   stock `navbar navbar-default` header and stock Bootstrap button
   styling — none of the project's own real components, tokens, or
   conventions applied.

**Screen B (clean).** A second panel, grounded against the same real
system, that exhibits none of the eleven checklist tells: it has a real
type hierarchy, a deliberate left-aligned grid, realistic-shape sample
data, an explicit empty state, focus/keyboard affordances, on-scale
spacing, only real tokens/classes, plain task copy, a loading affordance
on its async save, and consistent interaction with the rest of the app.

## Required behaviour (must all hold)

1. The agent runs the checklist **item by item** against Screen A and
   emits a per-item pass/flag result — not a holistic "this looks
   generic" verdict.
2. Every one of the seven tells present in Screen A is flagged, each flag
   quoting the specific offending element, and each anchored where a
   heuristic applies via `design-judgment-references`
   (`nielsen-heuristics.md`): framework-default chrome → item 1, H8;
   single-weight → H8; centred-everything → its
   checklist item; lorem ipsum → realism; missing empty state → H1;
   hover-only → H6; invented `btn-primary` → fiction tell (and H4 where
   consistency applies).
3. Each flag names the **owning skill for the fix** and does not attempt
   the fix here: hierarchy → `visual-hierarchy-and-type`, empty-state
   existence → `designing-states-not-screens`, copy → 
   `precision-copy-and-formatting`, invented class → 
   `grounding-before-designing`.
4. Screen B passes: the agent runs the same item-by-item checklist and
   flags **nothing**, producing no findings (silent pass), because none
   of the tells are present.

## Falsifier (this run is a FAIL if)

- Any one of the seven tells present in Screen A is not flagged (a missed
  tell) — including the framework-default-chrome tell, which must be
  flagged under item 1 and anchored to `nielsen-heuristics.md` H8, OR
- The output is a vibes verdict — "looks fine", "seems generic", "pretty
  clean" — delivered WITHOUT a recorded per-item pass/flag pass over the
  full checklist (the checklist was not actually run item by item), OR
- Any flag is delivered without quoting the specific offending element it
  condemns, OR without the Nielsen cross-reference where the checklist
  item carries one, OR without naming the owning skill for the fix, OR
- The agent fixes the tell here (rewrites the copy, restyles the
  hierarchy, adds the empty state) instead of flagging and pointing to
  the owning skill, OR
- Any tell is flagged on Screen B — a false positive on a screen that
  does not exhibit it — instead of Screen B passing silently. A flag on
  a clean screen is noise that trains dismissal and is a FAIL even though
  every Screen A tell was caught.

PASS requires: the full checklist run item by item on both screens; every
present tell on Screen A — all seven, including framework-default chrome
under item 1 anchored to H8 — flagged with quoted element + Nielsen anchor
(where applicable) + named owning skill and no fix attempted here; and
Screen B passing with zero flags and zero noise.
