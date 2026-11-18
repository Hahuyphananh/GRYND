# Motion Recipes

## Local Control

```css
.control {
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    transform 120ms ease;
}

.control:active {
  transform: translateY(1px);
}

.control:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
```

## Panel Entrance

```css
.panel {
  opacity: 0;
  transform: translateY(8px);
  transition:
    opacity 180ms ease,
    transform 220ms cubic-bezier(.2, .8, .2, 1);
}

.panel[data-open="true"] {
  opacity: 1;
  transform: translateY(0);
}
```

## Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 1ms !important;
  }
}
```

## Rules

- Avoid `transition: all`; animate specific properties.
- Animate opacity and transform before expensive layout properties.
- Keep hover states meaningful without requiring hover to understand the UI.
- Use skeletons only when shape helps users predict incoming content.
- Use progress indicators when duration is uncertain.

