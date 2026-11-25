# ACCEPTANCE — interaction-craft

One concrete, failable falsifier. The skill PASSES only if applying its
doctrine forecloses the failure described below.

## Scenario

A UI has an async action — a Save button on a settings form that writes to
a backend. The incoming ask is verbatim:

> "Add a nice loading animation and a fade transition so it feels polished
> when you save."

## FAIL (skill did not foreclose the failure)

Any of the following is produced:

- "Add a spinner on the button while it saves" with **no** explicit
  optimistic-vs-pessimistic decision and **no** stated reason for it.
- "Add a fade transition on the success state" justified as "looks nice" /
  "feels polished" / "feels smooth" — motion with **no** stated
  communicative purpose (what system status or state change it makes
  legible), and not cut.
- "Add a fade transition on the success state — it communicates that the
  save completed" — a **retrofitted / hollow purpose** where the signal is
  already carried by another affordance (the button returning to its default
  state, the form value updating, or a confirmation already shown by the
  states design) and the motion is kept rather than cut. Stating a purpose
  that another affordance already conveys is a FAIL, not a PASS.
- The interaction is specified for the mouse only — no statement of where
  focus goes after Save resolves and what the keyboard path is.

## PASS (doctrine forecloses it)

All of the following hold:

1. **Optimistic vs pessimistic is decided explicitly, with a reason** tied
   to failure cost, reversibility, and latency (e.g. "pessimistic: a failed
   settings write is high-cost and the user must not believe a bad value
   was saved; latency is sub-second so the wait is tolerable").
2. **Focus move and keyboard path are specified**: where focus lands on
   success and on error, how the action is reachable and confirmable from
   the keyboard, and how an error returns the user to the field to fix.
3. **Every proposed motion carries a stated communicative purpose** — what
   state change or system status it signals — and any motion that cannot be
   given one (the decorative fade, motion-for-feel) is **explicitly cut**,
   not kept.
