/**
 * The six product primitives, plus the local `cx` helper.
 *
 * Every one of them reads the semantic layer in `src/app/globals.css`
 * (`--bg-*`, `--text-*`, `--accent`, `--state-*`, `--border-*`) and none of
 * them accepts or contains a literal colour. Adopting them is therefore how a
 * screen gets both themes correct at once, rather than in a later pass.
 */
export { cx } from "./cx";
export { default as PageHeader } from "./PageHeader";
export { default as Surface } from "./Surface";
export { default as Button } from "./Button";
export { default as StatTile } from "./StatTile";
export { default as Tabs } from "./Tabs";
export { default as EmptyState } from "./EmptyState";
