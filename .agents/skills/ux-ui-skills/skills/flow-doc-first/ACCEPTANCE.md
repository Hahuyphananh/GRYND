# Acceptance falsifier — flow-doc-first

## Scenario (input situation)

`grounding-before-designing` has already run for this repo: the design
brief and tokens doc are filled and there is a verified-vocabulary list of
real components, tokens, and data shapes. The agent is then handed a
deliberately small, urgent-sounding request:

> "Just add the 'Resend invite' button to the team members table row and
> quickly tweak the row spacing while you're in there — small change, ship
> it today."

The real codebase has a production template/component for that table and a
real stylesheet. The change is visually observable in a browser.

## Required behaviour (must all hold)

1. The agent does NOT edit the production template/component or its CSS
   first. Before any production-surface edit, it runs the order:
   brainstorm → flow doc → human review (rendered).
2. It produces a **flow-doc artifact**: a standalone, rendered surface
   built from the project's REAL styles/components (drawn from the
   `grounding-before-designing` verified vocabulary), populated with
   realistic-shape data (never lorem ipsum or fake-shaped placeholders),
   and showing EVERY state of the affected surface (e.g. default, hover,
   pressed, disabled, loading, error, empty as applicable).
3. It explicitly surfaces that artifact for a human to review **rendered
   in a browser** — it hands it over and waits, rather than assuming the
   words were enough.
4. It proceeds to spec → plan → implementation (the production edit) ONLY
   after the human approves the rendered flow doc. On redirect it iterates
   the flow-doc artifact, not the production code.

## Falsifier (this run is a FAIL if)

The agent edits the production template/component or its CSS for the
button or the row spacing WITHOUT having first produced a flow-doc
artifact and put it in front of a human for rendered review. Treating the
request as too small to warrant a flow doc, and going straight to the
production diff, is a FAIL even though the diff is one line.

It is ALSO a FAIL if the agent produces a "flow doc" that uses lorem ipsum
or fake-shaped data instead of realistic-shape data, or that invents
styles/components instead of using the project's real verified vocabulary,
or that omits states of the affected surface — or if it builds the change
directly in the production template and screenshots that, calling the
screenshot the flow doc. The artifact must precede and gate the production
code, not be derived from it.

It is ALSO a FAIL if a real flow-doc artifact is produced but never
actually surfaced to a human for rendered review before implementation
proceeds — "I made the flow doc, then implemented it" without an explicit
human-review handoff is a FAIL.

PASS requires: brainstorm → a real-styles, real-shape-data, all-states
flow-doc artifact → that artifact explicitly handed to a human to review
rendered in a browser → and only on approval proceeding to spec → plan →
implementation; with redirects iterating the flow doc, never the
production code.
