# Acceptance falsifier — design-judgment-references

## Scenario (input situation)

An agent (or a reviewer the agent is assisting) is critiquing a rendered
screen during a `grilling-ui` or `anti-slop-audit` pass. It produces the
finding: "This screen feels off — it looks cluttered and not very clean,
and the dashboard panel just isn't professional." It then proposes
"tighten it up and make it cleaner" as the fix.

## Required behaviour (must all hold)

1. The agent does not accept "feels off / cluttered / not clean / not
   professional" as a finding. It treats the raw assertion as a *symptom*
   that is not yet a finding.
2. It matches the symptom to the correct reference in `references/` and
   names the exact source file **and** the specific principle within it —
   e.g. `nielsen-heuristics.md` **H8** (aesthetic & minimalist: extra
   units competing with relevant ones), or `atlassian-systems.md`
   (values that should be tokens, not magic numbers), or
   `atomic-design.md` (validated only as a template, never as a
   populated page).
3. It restates the fix in that principle's terms — e.g. "remove the three
   decorative panels that carry no information (H8: every extra unit
   competes)", not "make it cleaner".
4. If it believes there is genuinely no applicable principle, it first
   checks Rauno and Atlassian before saying so — most "pure aesthetic"
   calls have a named basis.

## Falsifier (this run is a FAIL if)

The agent reports "looks cluttered / feels off / isn't clean / not
professional" (or any restatement of the same) as a finding **without**
naming a specific source file in `references/` AND a specific principle
within it (a specific Nielsen heuristic *number*, a named Atlassian/
Linear/Rauno principle, or a named Atomic Design concept). It is also a
FAIL if the agent cites a source only generically — "this violates
Nielsen" or "Nielsen says so" without the heuristic number — or dresses
taste as consensus ("everyone knows this is bad") with no named anchor.
Restated taste with no named principle = FAIL even if the prose is
confident and the proposed fix is reasonable.

PASS requires: the vague assertion converted into a finding anchored to a
named, specific principle from `references/` (exact file + exact
principle), with the fix restated in that principle's terms.
