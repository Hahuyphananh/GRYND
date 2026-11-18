---
name: motion-and-interaction
description: Design and implement purposeful frontend motion and interaction details. Use when Codex needs to add hover states, pressed states, page transitions, layout transitions, scroll choreography, gestures, loading states, or reduced-motion behavior to a product UI.
---

# Motion And Interaction

## Rule

Motion must explain cause, state, continuity, progress, or affordance. Remove animation that only announces itself.

## Workflow

1. Identify the state changes users need to understand.
2. Choose the smallest motion vocabulary that covers those changes.
3. Prefer CSS transitions for local state and the existing animation library for complex choreography.
4. Add focus-visible, keyboard, pointer, and touch behavior together.
5. Respect `prefers-reduced-motion` and keep the reduced path useful.
6. Verify motion on at least one desktop and one mobile viewport when possible.

## Motion Roles

- Feedback: button press, control selection, validation.
- Orientation: navigation changes, panel open or close, route change.
- Continuity: item reordering, drag, layout changes.
- Progress: loading, streaming, upload, save.
- Attention: urgent status or new content.

## Timing Defaults

- 80ms to 140ms for direct feedback.
- 160ms to 240ms for panels, tabs, and small layout shifts.
- 280ms to 420ms for route transitions or staged reveals.
- Use shorter exit motion than entrance motion.

## Resources

- Read `references/motion-recipes.md` for implementation recipes and reduced-motion patterns.

