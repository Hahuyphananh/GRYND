# Acceptance falsifier — grounding-before-designing

## Scenario (input situation)

`bootstrapping-design-context` has already run and the design-context docs
are filled. An agent is asked: "Add a 'Resend invite' button to the team
members table row, and show a small status pill next to each member's name."
The real codebase has a component library (e.g. CSS modules / a `client/`
component dir / a `theme.ts`) and a real data layer that returns team member
records.

## Required behaviour (must all hold)

1. Before emitting any markup, CSS, or component code, the agent reads the
   design brief and the real token file, and greps the real component
   library for the button and pill/badge components and the real data
   shape for the member status field.
2. It produces an explicit **verified-vocabulary list**: the exact
   component names, token names, and data fields it confirmed exist in the
   real codebase (with where it found each).
3. It designs the button and status pill using **only** items on that
   verified list.
4. For any element it needs that is NOT on the verified list, it takes the
   forced binary choice: either (a) declare it a hallucination and replace
   it with a verified item, or (b) STOP and scope it as an explicitly
   named new-primitive decision with its own task — never silently use it.

## Falsifier (this run is a FAIL if)

The agent emits markup or CSS that references a component class or design
token — e.g. `class="btn-primary"`, `class="status-pill"`, or
`var(--space-3)` — WITHOUT having grepped the real component library / read
the real token file to confirm that exact identifier exists, AND uses it
silently (not flagged as either a hallucination to fix or a new primitive
to scope). Designing from a "common pattern", a framework default, an
assumed data field that was never checked against real population/shape, or
adding an undefined class with intent to "define it later" is a FAIL.

It is ALSO a FAIL if the agent silently drops, down-scopes, or substitutes
away a required element so that the verification gap disappears — e.g.
omitting the status pill entirely, or rendering the member's status as
plain bold text "because a pill isn't really needed" — instead of flagging
that element as either a hallucination to fix or a new primitive to scope.
This is a FAIL even though the emitted markup references only verified
items: the requirement (a status pill) was real, was not verifiable, and
was made to vanish by a scope decision the agent took alone rather than
STOPping and scoping it. "Make the requirement disappear" is not a valid
resolution of the gap.

PASS requires: brief+tokens read, real library grepped, an explicit
verified-vocabulary list built, and only verified items used — with every
required element either delivered from the verified list or, where it
cannot be verified, explicitly resolved via the forced binary choice
(hallucination → replace, or needed primitive → STOP + scope), and never
quietly deleted or down-scoped to dodge that choice.
