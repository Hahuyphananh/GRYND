# Release Checklist

## Rendered Views

- Desktop first viewport shows the product's real artifact or action.
- Mobile layout preserves task order instead of only stacking sections.
- Wide desktop does not stretch text beyond comfortable measure.
- Fixed-format elements use stable dimensions.
- No text overlaps, clips, or escapes controls.

## Interaction

- Main flow works with keyboard only.
- Focus ring is visible on controls and custom widgets.
- Disabled controls explain why they are unavailable when needed.
- Loading states do not shift layout unexpectedly.
- Empty states include a useful next action.
- Error states explain recovery.

## Accessibility

- Images have useful alt text or are decorative.
- Icon-only controls have accessible names.
- Motion respects reduced-motion settings.
- Color is not the only way state is communicated.

## Engineering

- Build script passes.
- Tests or manual verification cover the changed behavior.
- No placeholder content remains.
- No console errors appear during the main flow.

