# Acceptance falsifier — visual-hierarchy-and-type

## Scenario (input situation)

`grounding-before-designing` has already run for this repo: the design
brief and tokens doc are filled, and there is a verified-vocabulary list
of the project's REAL type scale steps, font weights, colour roles, and
spacing scale.

The agent is then handed a rendered screen — a submission detail panel —
in which everything is visually equal: the screen title, every field
label, every field value, the timestamp metadata, and a status string are
all the same type size, the same weight, the same colour, with uniform
even spacing between every element. It is a flat wall of equal text. The
agent is asked to make this screen read correctly.

## Required behaviour (must all hold)

1. The agent states an explicit **ranked focal order** for the screen:
   what should read 1st, 2nd, 3rd (and further as needed), derived from
   the user's actual scan goal on this screen — not a generic "headings
   bigger" gesture.
2. For **each** level in that ranked order, the agent names the
   **specific signal** carrying it — a size step, a font weight, a colour
   role, and/or a spacing/grouping move — and names it as one deliberate
   choice among the four levers, not "make it bigger".
3. Every size, weight, colour, and spacing value cited is a **real token**
   drawn from the `grounding-before-designing` verified vocabulary. No
   invented px/rem/pt values appear anywhere in the plan.
4. The plan checks rhythm/alignment against the real spacing scale and
   contrast at the project's real surfaces (including dark), and the
   resulting screen is no longer flat — the ranked order is achievable
   from the stated signals.

## Falsifier (this run is a FAIL if)

The agent responds with vague advice — "add more contrast", "make the
headings bigger", "use more whitespace", "increase visual hierarchy" —
without a ranked focal order and without naming which token carries each
level. Generic improvement language with no ranked plan is a FAIL.

It is ALSO a FAIL if the agent invents a type or spacing value (e.g.
"use 18px for the title", "set 1.5rem spacing", "try a 24pt heading")
instead of selecting from the project's grounded real token scale —
inventing a value is the fiction failure in this skill's domain. This
includes referencing a token or scale step by a vague name that is NOT
present in the grounded verified vocabulary (e.g. "the large heading
step" where no such token was grounded): a name that cannot be resolved
against the verified vocabulary is the same fiction as a raw px value.

It is ALSO a FAIL if the agent leaves the screen flat: declares it
"looks balanced" or "is fine now" because the elements are even, or
makes a single tweak (one heading enlarged) and stops — even spacing of
equal elements IS the flat-screen failure, and one tweak is not a ranked
plan.

PASS requires: an explicit ranked focal order (1st / 2nd / 3rd …) tied to
the user's scan goal, each level carried by a specifically named signal
from the four levers (size step / weight / colour role / spacing-
grouping), every value expressed in the project's REAL grounded tokens,
with rhythm/alignment and contrast (incl. dark surface) checked — leaving
a screen that demonstrably reads in the intended order.
