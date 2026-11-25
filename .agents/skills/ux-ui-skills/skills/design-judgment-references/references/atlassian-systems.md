# Atlassian Design System — Philosophy Distilled

Source: Atlassian Design System (design principles and foundations). The reference for system-level cohesion, tokens, and accessibility-as-foundation.

Cite as: `atlassian-systems.md` <principle name>.

- **One design language / cohesion.** The system exists so that many teams and many products feel like one product. Cohesion is the goal; a screen that is internally pretty but inconsistent with the system has failed the primary objective. The judgment question: "is this the same language the rest of the system speaks?"
- **Consistency anchored in measurable, reusable elements — not subjective rules.** Consistency is enforced through shared, named building blocks: design tokens, a defined type scale, a defined colour palette, and a shared iconography set. "Be consistent" is not actionable; "use the existing token / type ramp / palette entry" is. If a value is not a token, that is the finding — not "it looks slightly off".
- **Accessibility as a foundational layer, not an afterthought.** Contrast, focus order, target size, and semantics are part of the definition of done — designed in from the start, not retrofitted. An inaccessible component is incomplete, not "polished later".
- **Understand the underlying material of the technology.** Designs must respect the medium they are built in (the web platform, the component framework, real rendering behaviour). Designing against the grain of the material produces fragile UI; honour what the platform does natively.
- **A living system informed by research.** The system is not frozen; it evolves from evidence and usage. A proposed change is judged against research and system impact, not one screen's local convenience.

## When to anchor here

Use Atlassian when the finding is about **system cohesion, tokens, type/colour scale, iconography consistency, or accessibility as a baseline**. "This value should be a token, not a magic number" and "this contrast fails the accessibility baseline" are Atlassian-anchored findings, not taste.
