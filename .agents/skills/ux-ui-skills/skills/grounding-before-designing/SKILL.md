---
name: grounding-before-designing
description: Use before producing, changing, or proposing any UI, when about to reference a component, design token, or data shape in a repo.
---
<!-- type: rigid -->

## Doctrine

**No UI from training data or first principles. The real codebase is the only source of truth for what components, tokens, and data exist.** This skill is the anti-fiction guardrail at the data/component level — the level below the brief. The brief tells you what the product is; this skill makes sure every concrete thing you reference to build it actually exists. Your training data knows a thousand button conventions and a thousand spacing scales. None of them are this repo's. The only authority is what you can grep and read in the real source tree right now. A pattern being "standard" is not evidence it exists here; it is evidence you are about to invent.

**Verify-before-reference is a literal, mechanical rule, not an attitude.** Before any markup, CSS, or component code is emitted: every component must be grepped against the real component library, every token must be read out of the real token/theme file, and every data field must be checked against the real data shape or a representative populated record. "Be careful" is not the instruction. The instruction is: run the grep, open the file, look at the field. If you did not run the search, you do not know the thing exists, and you may not reference it.

**An unknown reference forces a binary choice — there is no silent third path.** When you need something that is not on the verified list, you have exactly two moves. (a) It is a hallucination: remove it and replace it with a verified item. (b) It is a genuinely needed new primitive: STOP, and scope it as its own explicit, named decision with its own task — not folded into this work. The forbidden move, the one this skill exists to kill, is the third path: "I'll just use `.btn-primary` and assume it's there" or "I'll add the class now and define it later." That path always looks fine in review and always ships broken. There is also a fourth forbidden move, the inverse of the third: silently dropping or down-scoping a required element so the verification gap simply vanishes — "I don't really need a status pill, I'll just use bold text." A needed element that cannot be verified is a STOP-and-scope decision, never a thing you quietly delete or substitute away. The binary choice is (a) hallucination → replace or (b) needed primitive → STOP + scope; "make the requirement disappear" is not a third option.

**Why this exists: invented references are invisible in the diff and only surface rendered.** A guessed `--space-3` or a hallucinated `.status-pill` is syntactically perfect. It passes lint, passes type-check, reads naturally in the PR, and gets approved — because the reviewer cannot see that the token resolves to nothing and the class matches no rule. The failure class is *plausible fiction that is undetectable until a human loads the page*. Grounding is the only point in the pipeline where this bug is cheap to catch; after this gate it is invisible until production.

**Gate position is fixed.** This skill requires `bootstrapping-design-context` to have already run and produced filled docs — without the brief and tokens doc there is nothing to ground against. This skill is itself a precondition of `flow-doc-first` and `grilling-ui`: do not design flows or stress-test screens on top of unverified vocabulary. Run this, in this order, every time UI is produced or changed — not once per repo.

## Process

1. **Locate context.** Find the filled design brief, the real token/theme file, the real component library directory, and a populated record that actually contains the field(s) you intend to bind for the screen in question. Note the exact paths.
2. **Read it.** Read the brief and the token file. Do not skim — you will cite specific token names, so you must have seen them.
3. **Grep the library.** For every component you intend to reference, grep the real component library for it. For every token, confirm the exact identifier in the token file. For every data field, confirm it against the real shape/population, not an assumption.
4. **Build the verified-vocabulary list.** Write an explicit list: each component, token, and data field you confirmed exists, and where you found it. This list is the entire permitted vocabulary for the next step.
5. **Design using only that list.** Emit markup/CSS/component code that references nothing outside the verified-vocabulary list. Cite the verified source for non-obvious references.
6. **Resolve every gap by the forced binary choice.** For anything you needed that is not on the list: either declare it a hallucination and replace it with a verified item, or STOP and scope it as a separate, explicitly named new-primitive decision with its own task. Never the silent third path.

## Red flags

| Rationalisation | Reality |
|---|---|
| "This component probably exists, it's a common pattern." | "Probably" means you did not grep it. Common patterns are training-data fiction until proven present in *this* library. Grep it or it does not exist. |
| "I'll use a sensible default spacing value." | There are no defaults here. The only valid spacing values are the ones in the real token file. Read the file; cite the token; never invent the number. |
| "The data always has this field." | "Always" is an assumption you did not check. Assumed fields are the silent-empty-state bug. Confirm it against the real shape or a populated record before you bind to it. |
| "I'll add the new class now and define it later." | An undefined class renders broken and is invisible in the diff. "Later" never gets its own scrutiny. Scope it as its own named decision *before* you reference it, or do not reference it. |
| "The brief mentions this component, so it's safe to use." | The brief describes intent, not implementation. A component named in the brief still must be grepped in the real library; intent is not existence. |
| "I don't really need that component — I'll just use something simpler that already exists." | Down-scoping a real requirement to dodge the STOP is the same fiction in reverse — you've now shipped a screen that silently doesn't do what was asked. A gap you can't verify is a scope decision, not a deletion you make alone. |
| "It's a tiny tweak, grounding is overkill here." | Tiny tweaks are where unverified references slip in unreviewed. The cost of one grep is trivial; the cost of a fictitious reference shipping is a rendered-only bug. Ground every change. |
