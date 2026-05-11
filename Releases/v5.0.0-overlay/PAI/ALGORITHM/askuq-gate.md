# Algorithm v6.3.0+local — AskUserQuestion ENUMERATE→OFFER phase-exit gate

This file is an addendum to v6.3.0's OBSERVE phase. It does NOT replace
`~/.claude/PAI/ALGORITHM/v6.3.0.md` — it adds one phase-exit gate that the
upstream Algorithm doesn't currently enforce.

The gate is read at OBSERVE→THINK transition. Implementations that load
the v6.3.0 doctrine should also load this addendum.

---

## ENUMERATE→OFFER — OPEN CHOICES GATE (MANDATORY before exiting OBSERVE)

After v6.3.0's OBSERVE phase completes its existing checks, before entering
THINK, enumerate every discrete multi-option decision that BUILD/EXECUTE will
make. For each enumerated decision, take exactly one of two paths:

1. **Commit with rationale** — decide now, state the chosen option and a
   one-sentence reason in the ISA's `## Decisions` section. Appropriate when
   the choice is low-stakes, reversible, or the right answer is evident from
   current context.
2. **Offer via `AskUserQuestion`** — surface the choice *before* BUILD begins
   by invoking `AskUserQuestion` at the end of the current response (after
   the response-format output is complete). Appropriate when the choice
   materially changes the output, is hard to reverse, or the user has
   signalled preference-sensitivity.

### Eligibility — what qualifies as an enumerable choice

- Must have 2–4 discrete, mutually exclusive options
- Each option must be expressible as a short label
- Free-text decisions (wording, tone, naming) DO NOT qualify — never
  enumerate prose
- Subjective decisions (aesthetic, stylistic) DO NOT qualify — those are
  for the user to express, not to pick from a menu
- Decisions with >4 options DO NOT qualify — restructure into a nested
  decision tree if genuinely needed

### Emit to output

Regardless of path chosen, every enumerated decision is listed on the
`❓ OPEN_CHOICES:` line of the response output. The value `none` is valid
*only* when no enumerable multi-option decisions exist in the plan.

### Batching

If multiple open choices remain after enumeration, combine them into a
single `AskUserQuestion` invocation — the tool accepts up to 4 questions
per call — rather than asking serially across turns.

### Subagent delegation

Subagents MUST NOT invoke `AskUserQuestion` directly (they lack the tool
and would break the one-asker invariant). They return
`pending_user_choices[]` in their result; the DA aggregates and asks.

### Worked example — commit-with-rationale path

> Decision: *heading level for a new subsection*. Options: H2, H3, H4.
> Commit: **H3 — the surrounding section uses H2, so H3 is the logical
> child.** No user prompt needed; low-stakes and evident from context.
> Recorded in `## Decisions` with one sentence.

### Worked example — AskUserQuestion path

> Decisions: *(a) branch-naming convention (`NNN-kebab` vs
> `feat/NNN-kebab`); (b) whether to bundle two related work items into one
> PR or split them.* Both are material to the output, both have 2–3
> enumerable options, neither has a self-evident default. Batch into a
> single `AskUserQuestion` call with two question entries at the end of
> this OBSERVE response.

---

## Why this is a gate, not just a behavioural rule

Behavioural-rule-only enforcement showed drift across 20+ low-rated sessions
in the fork's predecessor (`virtualian/pai`'s v3.7.0) where the user
expected a question and did not receive one. Converting the rule to a
phase-exit check creates symmetry with the existing `❓ OPEN_CHOICES:`
output field — both must produce a non-empty value or pass the
"none-because-verified" check before THINK begins.

## Provenance

Adapted verbatim (with minor wording adjustments to match v6.3.0's
ISA-based vocabulary) from the fork's `Algorithm/v3.7.0.md` OBSERVE
phase, sub-step "ENUMERATE→OFFER".
