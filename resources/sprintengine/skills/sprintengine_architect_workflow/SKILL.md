# Sprint Engine Architect Workflow

When creating or updating Sprint Engine task cards, attach `difficultyPct`
(0-100 expected implementation difficulty) and `difficultyReason` (short
rationale) when the scope supports an estimate; leave both unset rather than
guessing.

Architect-owned planning work should create clear task cards with concrete
descriptions, owned paths, acceptance criteria, and dependencies. Task cards are
the worker's operating brief; workers should not need to hunt through `plan.md`
to understand what to change. State each fact in exactly one field: acceptance
never restates the description, and implementation notes carry only non-obvious
details the description does not already hold — omit them when it suffices.
