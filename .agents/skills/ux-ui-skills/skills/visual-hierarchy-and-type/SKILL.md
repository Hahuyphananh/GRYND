---
name: visual-hierarchy-and-type
description: Use when laying out a screen or composing typography and spacing, or when a screen reads flat with no clear focal order.
---
<!-- type: flexible -->

## Doctrine

**Hierarchy is a designed signal, not an accident.** Every screen has a reading order — the sequence in which the eye lands on things before the user consciously parses anything. You either decide that order or the screen decides it for you, and the screen's default decision is *flat*: everything equal, nothing first. There is no neutral option. A screen where the title, the labels, the values, and the metadata all carry the same visual weight is not "clean" or "balanced" — it is a screen whose author declined to choose, and the user pays for that with every scan. The job of this skill is to make the screen read in the *intended* order pre-attentively, which means the order must first be intended.

**The levers are exactly four, and "make it bigger" is not the skill.** Hierarchy is built from: **size** (a step on the type scale), **weight** (font weight), **colour role** (a semantic colour token — primary text vs. secondary vs. muted), and **space/grouping** (proximity and rhythm on the spacing scale). A real hierarchy plan assigns a *specific* lever (often a combination) to *each* level of the focal order. Reaching only for size — enlarging the heading and calling it done — uses one lever, leaves the other three flat, and is the most common counterfeit of this skill. Name the lever per level or you have not done the work.

**Real tokens only — inventing a value is the fiction failure here.** Type scale steps, weights, colour roles, and spacing values come from the project's verified token vocabulary, established by `grounding-before-designing`. This skill never invents a size or a spacing value. "Use 18px", "try 1.5rem", "a 24pt heading" — these are fabrications dressed as craft; they bypass the scale the system was built on and produce drift no token can later absorb. If the grounded scale lacks a step you think you need, that is a finding to raise against `grounding-before-designing` as a scale-gap finding before proceeding, not a number to invent. Defer to `grounding-before-designing` for the verified vocabulary; this skill consumes it, never substitutes for it.

**Density and contrast are disciplined, not maximised.** Enough hierarchy to scan; not so much the screen shouts. Every level distinguished by its own size *and* weight *and* colour is noise, not order — pick the minimum signal that separates levels cleanly. Contrast must hold at the project's *real* surfaces, including dark mode, where muted colour roles silently fail and a hierarchy that looked right on white collapses. This is a tokens-not-taste judgment: anchor the call to `design-judgment-references` (Atlassian — hierarchy decisions belong to the token system, not subjective per-screen rules; Rauno — polish comes from constraint, the disciplined minimum, not from adding signal).

**The flat screen is the default failure, and it is the most common silent slop tell.** Equal-weight everything is precisely what you get by *not* deciding hierarchy — it requires no decision, so it is where unreviewed UI lands. It rarely looks broken; it looks "fine", which is why it ships. This skill exists because the absence of hierarchy is the quietest and most frequent way a screen reads as machine-made. "It looks balanced, everything's even" is not a defence — it is the symptom. Flexible refers to *how you reach the plan*; exactly one rule overrides that flexibility: **no hierarchy work ships without an explicit ranked focal order with a named real-token signal (size step / weight / colour role / spacing) per level.** This output is non-negotiable, not one heuristic among several.

## Process

1. **Establish the scan goal → information priority.** Ask what the user is on this screen *to do*, and from that derive what must read 1st, 2nd, 3rd. This is a ranked list of *content roles* (e.g. "the entity's identity reads 1st; its current status 2nd; field detail 3rd; provenance metadata last"), not yet any styling.
2. **Assign a specific signal per level, in real tokens.** For each level in the ranked order, choose the lever(s) — a named type-scale step, a named weight, a named colour role, a spacing/grouping move — drawn from the `grounding-before-designing` verified vocabulary. Prefer the minimum signal that separates the level from its neighbours; combine levers only when one does not cleanly separate.
3. **Check rhythm and alignment on the real spacing scale.** Spacing between and within groups must come from the grounded spacing steps and should reinforce grouping (tighter within a group, looser between). Check optical alignment, not just nominal alignment.
4. **Check density and contrast at the real surfaces.** Confirm the plan is the disciplined minimum (no level over-signalled) and that every colour role used clears contrast at the project's real surfaces, dark mode included. Anchor any contested call to `design-judgment-references`.
5. **State the resulting ranked focal order explicitly.** Write it out: "Reads 1st: <content> via <token signal>; 2nd: <content> via <token signal>; …". If you cannot state it as a ranked list with a named signal per level, the screen is still flat — return to step 1.

## Red flags

| Rationalisation | Reality |
|---|---|
| "I'll just make the heading bigger." | Size is one of four levers. Enlarging one element is not a hierarchy plan; it leaves weight, colour role, and spacing flat. State the full ranked order with a named signal per level. |
| "Add more contrast / more whitespace and it'll be fine." | Vague. Which level? Which signal? Which token? Improvement language with no ranked focal order and no named tokens is the FAIL this skill names. |
| "I'll use 18px / 1.5rem / a 24pt heading here." | Invented value. The grounded type and spacing scale is the only source; a fabricated number is fiction and produces drift no token can absorb. Use the scale or raise a scale-gap finding against `grounding-before-designing` before proceeding. |
| "It looks balanced — everything's even." | Even IS the flat-screen failure. Balance of equal elements is the absence of hierarchy, not hierarchy. "Even" is the symptom, not the defence. |
| "Every level gets its own size, weight, and colour — maximum clarity." | Over-signalling is noise, not order. The minimum signal that cleanly separates levels is the craft; piling on levers is the opposite of polish. |
| "It read fine on the light mockup, ship it." | Muted colour roles silently fail on the project's real dark surface. Contrast must be checked at the real surfaces, dark mode included, before the plan stands. |
| "It's a flexible skill, so I can describe the hierarchy without writing the ranked list." | Flexible refers to approach, not to the one non-negotiable output. No ranked focal order with a named real token per level means the work is not done. |
