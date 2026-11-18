# Nielsen's 10 Usability Heuristics (NN/g)

Source: Jakob Nielsen, "10 Usability Heuristics for User Interface Design" (Nielsen Norman Group). General principles for interaction design; the usability floor every UI must clear.

Cite as: `nielsen-heuristics.md` H<n>.

- **H1 — Visibility of system status.** The design should always keep users informed about what is going on, through appropriate feedback within a reasonable amount of time.
- **H2 — Match between the system and the real world.** Speak the users' language with familiar words, phrases, and concepts; follow real-world conventions and a natural, logical order.
- **H3 — User control and freedom.** Users need a clearly marked "emergency exit" — support undo and redo so mistaken actions can be left without an extended process.
- **H4 — Consistency and standards.** Users should not have to wonder whether different words, situations, or actions mean the same thing; follow platform and industry conventions (Jakob's Law).
- **H5 — Error prevention.** Better than good error messages is a careful design that prevents problems from occurring in the first place — eliminate error-prone conditions or confirm before commitment.
- **H6 — Recognition rather than recall.** Minimise memory load by making elements, actions, and options visible; the user should not have to remember information from one part of the interface to another.
- **H7 — Flexibility and efficiency of use.** Accelerators (unseen by novices) let experienced users speed up frequent actions; allow tailoring of frequent actions.
- **H8 — Aesthetic and minimalist design.** Interfaces should not contain information that is irrelevant or rarely needed; every extra unit of information competes with the relevant units and diminishes their relative visibility.
- **H9 — Help users recognise, diagnose, and recover from errors.** Error messages in plain language (no codes), precisely indicating the problem and constructively suggesting a solution.
- **H10 — Help and documentation.** It is best if the system needs no documentation, but it may be necessary to provide help that is easy to search, focused on the user's task, and lists concrete steps.

## Anti-slop note

AI-generated UI most often violates:

- **H4 (consistency & standards)** — same concept rendered three different ways across screens; invented controls where a platform convention exists.
- **H6 (recognition over recall)** — hiding state/options so the user must remember context instead of seeing it.
- **H8 (aesthetic & minimalist)** — decorative filler, redundant labels, gratuitous panels. Every extra unit competes with the signal and dilutes it.

These three are the primary feed for the anti-slop guardrail. When a screen "feels cluttered" or "looks generic", the anchor is almost always H8, H4, or H6 — name the number.
