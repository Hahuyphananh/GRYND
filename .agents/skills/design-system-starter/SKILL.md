---
name: design-system-starter
description: Create or extend practical frontend design systems with tokens, component contracts, state rules, and migration steps. Use when Codex needs to establish color roles, typography, spacing, radius, elevation, interaction states, or reusable UI primitives for a product interface.
---

# Design System Starter

## Goal

Create a design foundation that is small enough to ship and strong enough to keep future screens coherent.

## Workflow

1. Inspect the app stack, existing styling approach, and component library before proposing files.
2. Define role-based tokens for color, typography, spacing, radius, elevation, borders, and motion.
3. Establish component contracts for the primitives the product actually needs.
4. Include state rules for hover, focus, active, disabled, loading, selected, error, and success.
5. Migrate one representative screen or component so the system is proven in code.
6. Document only the decisions future contributors must follow.

## Token Principles

- Name tokens by role, not appearance.
- Keep primitives private when possible and expose semantic aliases.
- Use a restrained scale before adding exceptions.
- Make text, surfaces, borders, and actions distinct roles.
- Keep responsive values explicit instead of scaling type directly with viewport width.

## Component Contract

For each component, specify:

- Purpose and allowed variants.
- Required and optional props.
- Supported sizes and density.
- Accessibility requirements.
- Content limits and overflow behavior.
- Interaction states.
- Example usage.

## Resources

- Read `references/tokens.md` before creating token files.
- Read `references/component-contracts.md` before designing reusable components.

