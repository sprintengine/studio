---
name: nuclear-review
description: Run a strict maintainability and structure review of code changes. Use when asked for Nuclear Review, Nuclear Reviewer, NuclearReview, NuclearReviewer, thermonuclear review, harsh code-quality audit, AI-slop review, abstraction review, large-file review, spaghetti-condition review, or a review that should reject working code when it makes the codebase harder to maintain.
---

# Nuclear Review

Use this skill as the Nuclear Reviewer quality bar: behavior passing is not enough. Review whether the change leaves the codebase simpler, more local, easier to scan, and easier to evolve.

Source basis: adapted from Cursor's `thermo-nuclear-code-quality-review` skill in `cursor/plugins` (`cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md`) and its matching subagent prompt. This version is intentionally compressed for Multicode project use.

## Review Workflow

1. Inspect the diff, changed files, and nearby canonical helpers before judging structure.
2. Identify the main design move the change makes: new branch, new module, new state, new abstraction, new type boundary, or new orchestration.
3. Look for a simpler behavioral equivalent that deletes concepts, branches, wrappers, casts, modes, or layers.
4. Report only high-conviction maintainability findings. Skip cosmetic nits when structural issues exist.
5. If no issues meet the bar, say that clearly and note residual risk or verification gaps.

## Blocking Bar

Treat these as presumptive blockers unless the implementation has a clear, documented reason:

- A file crosses from below 1000 lines to above 1000 lines, or grows into an obviously less scannable module.
- New special-case branches, booleans, nullable modes, or condition chains tangle an existing flow.
- A wrapper, adapter, generic mechanism, cast, `any`, `unknown`, optional field, or silent fallback hides a simpler invariant.
- Feature logic leaks into a shared path, API details leak across a boundary, or a bespoke helper duplicates a canonical helper.
- A refactor moves complexity around without reducing the number of concepts a reader must hold.
- Independent work is serialized or related mutations are split when a simpler parallel or atomic structure is obvious.
- The code technically works but leaves surrounding code more coupled, stateful, magical, or hard to reason about.

## Review Questions

Ask these for every meaningful change:

- Can the same behavior be reframed so whole branches, helpers, modes, or layers disappear?
- Is this logic in the file, package, service, component, or command that already owns the concept?
- Did the change make a cohesive module more coupled, stateful, indirect, or hard to scan?
- Are repeated conditionals signaling a missing model, dispatcher, helper, or ownership boundary?
- Does an abstraction clarify behavior, or only rename/pass through data?
- Are type boundaries explicit enough to remove casts, optional churn, or defensive fallback?
- Does orchestration reflect real dependencies, or is it sequential/partial out of habit?

## Preferred Remedies

Prefer recommendations that remove complexity rather than polish it:

- Delete an indirection layer, wrapper, branch family, duplicated helper, or mode.
- Move logic to the canonical owner instead of spreading feature checks through shared code.
- Split a large file into focused modules with real ownership, not arbitrary buckets.
- Replace condition chains with an explicit typed model, dispatcher, or policy object.
- Extract pure helpers only when they reduce local reasoning cost.
- Collapse duplicate paths into one clearer flow.
- Make boundary contracts explicit so fallback and casts become unnecessary.
- Parallelize independent work or make related updates atomic when that simplifies reasoning.

## Output Format

Lead with findings, ordered by severity:

- `Blocking:` structural regressions, missed simplification, spaghetti growth, boundary/type leaks, large-file decomposition failures.
- `Important:` maintainability concerns that should be fixed but do not clearly block acceptance.
- `Residual risk:` what was not verified or what depends on assumptions.

For each finding, include:

- File and line reference when available.
- The maintainability failure in concrete terms.
- The simpler direction or acceptance condition.

Be direct and serious. Do not approve merely because tests pass or behavior appears correct.
