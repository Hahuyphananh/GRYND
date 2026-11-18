# Rauno Freiberg — Interaction Craft Principles

Source: Rauno Freiberg, "UI Playbook" / interaction-craft writing (rauno.me). The reference for motion, depth, and interaction polish — the principled basis for "feel".

Cite as: `rauno-craft.md` <principle name>.

- **Motion communicates intent, it is not decoration.** Animation exists to explain a relationship — where a thing came from, where it went, what caused what. Motion that does not clarify causality or continuity is noise. The judgment question for any transition: "what does this motion explain?" If the answer is "nothing, it looks nice", it is decoration and should be cut or made meaningful.
- **The invisible details of interaction.** Perceived quality lives in the states most designs ignore: hover, focus, active/pressed, disabled, loading, empty, error; keyboard behaviour; hit-target generosity; text selection; scroll and overflow behaviour. A component judged only in its default state is unjudged. Polish is the sum of these invisible states being deliberately handled.
- **Designing depth and spatial intelligence.** Interfaces have a spatial model — layering, elevation, what is above/behind what, where overlays originate, minimaps and orientation cues. Coherent depth helps users build a mental model; arbitrary z-order and ungrounded overlays break it. Judge whether the spatial model is consistent, not just whether it looks layered.
- **Polish through constraint — precision controls over generic inputs.** A control purpose-built and constrained to its actual domain (a stepper, a constrained slider, a typed picker) beats a generic free-text input that permits invalid states. Precision and constraint are a quality signal; generic inputs that allow nonsense are a craft failure, not a neutral choice.

## When to anchor here

Use Rauno when the finding is about **motion that doesn't explain anything, missing interaction states (hover/focus/active/disabled/loading/empty/error), incoherent depth/layering, or a generic input where a precise constrained control is warranted**. "This transition is decorative and explains no relationship" and "this component has no defined focus or loading state" are Rauno-anchored findings, not vibes.
