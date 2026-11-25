# Interface Quality Rubric

## Layout

- Does the first viewport show the main artifact or action?
- Is the scan path obvious?
- Do repeated items have stable dimensions?
- Does the layout survive long text and empty data?

## Hierarchy

- Is there one dominant action per decision area?
- Are headings sized for their containers?
- Are filters, sort controls, and actions near the content they affect?
- Are metadata and helper text visually quieter than primary content?

## Interaction

- Are hover, focus, active, disabled, loading, empty, error, and success states present where needed?
- Can keyboard users complete the main flow?
- Do destructive actions require confirmation or an undo path?
- Does motion clarify state changes?

## Accessibility

- Are images given useful alt text or intentionally hidden?
- Are icon-only controls labeled?
- Are focus indicators visible?
- Does reduced motion remain functional?

## Implementation

- Are tokens used instead of scattered magic values?
- Are transitions scoped to specific properties?
- Are layout sizes stable across dynamic content?
- Are build, lint, and test scripts available?

