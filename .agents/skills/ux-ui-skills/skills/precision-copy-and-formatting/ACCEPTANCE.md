# Acceptance falsifier — precision-copy-and-formatting

## Scenario (input situation)

`designing-states-not-screens` has decided which states a **"Delete
submission" confirmation surface** must have and has handed off to this
skill to produce the words and formatting for those states. The agent is
handed the following concrete artifact and asked to make it ship-ready:

- The error state currently reads: **`"Oops! Something went wrong 😬"`**
- The submission's amount is rendered to the user as: **`12.5`**
- The "Delete" control fires immediately on click with **no confirmation
  step at all**, and deleting a submission is irreversible.

The framing handed to the agent is:

> "States are decided. Polish the copy and numbers and wire the delete —
> the message is friendly enough, 12.5 is fine, and we can skip a confirm
> dialog to keep it fast."

## Required behaviour (must all hold)

1. The agent **rewrites the error to the structure `[What's wrong]. [What
   to do].`** — specific cause plus the concrete next action, with no
   fake cheerfulness, no emoji-as-tone-fix, no marketing-speak. It states
   that `"Something went wrong"` is a non-message and anchors this to
   Nielsen H9 via `design-judgment-references`.
2. It **formats the amount locale-aware and with currency** (e.g.
   `$12.50` for en-US USD), explicitly **never as the bare float `12.5`**,
   and names this a correctness bug (the generalised djmoney-class bug),
   not a polish nicety. It anchors clear, user-language formatting to
   Nielsen H2 via `design-judgment-references`.
3. It **requires a confirmation step proportional to blast radius**: an
   irreversible delete gets an explicit confirmation that names what is
   lost (not silent execution, and not a blanket dialog reflex applied
   without reference to blast radius).
4. It **does NOT decide which states/screens should exist** — it produces
   words and formatting for the states it was handed and explicitly leaves
   state/screen existence to `designing-states-not-screens`.

## Falsifier (this run is a FAIL if)

It is a FAIL if the agent leaves the error fake-cheerful or vague (any of
`"Oops!"`, `"Something went wrong"`, or an emoji standing in for clarity)
instead of rewriting it to `[What's wrong]. [What to do].`.

It is ALSO a FAIL if the agent renders the amount as the raw float `12.5`
(or any unlocalised, currency-less number), or renders a raw ISO timestamp
as user-facing date text, or treats this as cosmetic polish rather than a
correctness bug.

It is ALSO a FAIL if the agent ships the irreversible delete with **no
confirmation**, OR reflexively applies a heavy confirmation to a trivial
undoable action without reference to blast radius — both under- and
over-confirming fail.

It is ALSO a FAIL if the agent **invents which states or screens should
exist** (e.g. "I'll also add an empty state / a new error screen here") —
state existence is owned by `designing-states-not-screens`; this skill
owns only what each handed state says and how it is formatted.

PASS requires: error rewritten to `[What's wrong]. [What to do].` (H9 via
`design-judgment-references`) → amount formatted locale-aware with
currency, never a bare float (H2 via `design-judgment-references`) →
confirmation proportional to blast radius for the irreversible delete →
with no claim over which states/screens exist.
