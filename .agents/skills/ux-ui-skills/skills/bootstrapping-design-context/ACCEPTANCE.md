# Acceptance falsifier — bootstrapping-design-context

## Scenario (input situation)

An agent is invoked in a target repo that has **no** design-context docs:
`docs/design-brief.md`, `docs/design-tokens.md`, and
`docs/interaction-system.md` are all absent. The user says: "Make the
dashboard look more polished." There is a `README.md` that mentions the
product is a coffee-trading platform, and a `client/` directory with real
components.

## Required behaviour (must all hold)

1. The skill runs the bootstrap scaffolder
   (`bin/bootstrap.py --detect <repo>` then `bin/bootstrap.py <repo>`)
   against the target repo before doing any UI work.
2. It reports, explicitly, which scaffold files were **created** versus
   **skipped (exists)**.
3. It then **HALTS** and instructs that the brief, tokens, interaction
   system, vocabulary, flow-doc convention, and steward agent must now be
   filled by **interviewing the team and reading the real codebase**, and
   names `grounding-before-designing` as the next skill.

## Falsifier (this run is a FAIL if)

The agent produces a **filled-in** `docs/design-brief.md` — e.g. it writes
brand adjectives, personas, or tone derived from the README's "coffee-trading
platform" hint, from its own knowledge of coffee-trading domains, or from any
other project it has seen. ANY non-template content authored into the brief,
tokens, or interaction-system docs by the agent (rather than by a human
interview) is a FAIL. Proceeding to restyle the dashboard without first
scaffolding and halting is also a FAIL.
