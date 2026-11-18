# Atomic Design — Brad Frost, Distilled

Source: Brad Frost, "Atomic Design" (atomicdesign.bradfrost.com). The reference for component composition and structural judgment.

Cite as: `atomic-design.md` <principle name>.

## The five levels

- **Atoms.** The foundational building blocks — a label, an input, a button, a colour, a font. They are not very useful alone but are the irreducible base.
- **Molecules.** Small groups of atoms bonded together to do one thing — e.g. a label + input + button forming a search form. The simplest functional unit; "do one thing well".
- **Organisms.** Relatively complex components composed of molecules and/or atoms forming a distinct section — e.g. a site header (logo + nav + search). Organisms give context and standalone meaning.
- **Templates.** Page-level structures that place organisms into a layout. Crucially, templates show the **content skeleton** — they articulate the underlying content structure and enforced sizes/constraints, not the final content.
- **Pages.** Specific instances of templates with **real representative content** substituted in. Pages are where the design system is tested and where the template's structure is validated against real-world content variation.

## Non-linear mental model

Atomic Design is **explicitly not a sequential, linear process**. The five stages are a mental model for thinking about UI as simultaneously a cohesive whole and a collection of parts — not steps you complete in order. You move between levels freely.

**Parts influence the whole and the whole influences the parts.** Decisions about an atom ripple up into every organism that uses it; the needs of a page can force a change back down to a molecule. The relationship is bidirectional and continuous, not bottom-up only.

## Templates vs Pages — the testing distinction

- **Templates** = content-agnostic skeleton: structure, hierarchy, enforced sizes, the shape content must fit. They prove the *system's* structure.
- **Pages** = concrete instances with real, representative, varied content (longest name, empty list, error string, huge number). Pages prove the design survives reality. A design only validated as a template, never as populated pages, is unvalidated against content variation.

## When to anchor here

Use Atomic Design when the finding is about **the composition level being wrong** (an organism's logic stuffed into an atom; a one-off page-specific component that should be a reusable molecule), **a change made at the wrong level** (patched on a page when it belongs in the atom), or **a design validated only as an empty skeleton, never as populated real-content pages**. "This was only ever seen as a template, never tested as a page with real content" is an Atomic-Design-anchored finding, not a hunch.
