---
name: studio-diff-tours
description: Walk the owner through your changes as a guided tour inside SprintEngine Studio's Diff viewer, with the tour_* tools — one step per idea, your notes beside the code, questions coming back to your terminal. Use when the owner asks you to walk them through, explain, or tour what you changed; when you have just finished a large or multi-file change and want to offer a walkthrough; or when a message arrives prefixed `[Tour "…" · step …]`, which is the owner asking about one of your tour's steps.
---

# Walking the owner through your changes

A tour is a sequence of steps the owner plays in the Diff viewer. Each step
points at lines of one changed file and says, in your words, why that code is
shaped the way it is. The viewer highlights the lines, sets the rest of the file
back, and shows your note in the code under them. The owner steps with `]` and
`[`, and can ask about any step — the question arrives in your terminal.

## When to make one

- **When the owner asks** ("walk me through it", "explain what you changed").
- **Offer, do not create,** after a large multi-file change: say that a tour is
  available and make it if they want one. A tour nobody asked for is noise.
- Not for a one-line fix. The diff already says everything.

## Writing it: `tour_create`

Write the **whole** tour in one call. Every anchor is resolved before the tour
is accepted; if anything is wrong the call fails with the complete list of
problems, each naming the step and what would work. Fix them all and call again.

```json
{
  "title": "Retry with jittered backoff",
  "overview": "Optional markdown for the Start card.",
  "changes": { "kind": "changelist" },
  "steps": [
    {
      "id": "options",
      "title": "The new retry options",
      "body": "`delayMs` becomes a base and a ceiling …",
      "path": "src/queue/retry.ts",
      "match": "export type RetryOptions = {",
      "lineCount": 8
    }
  ]
}
```

`changes` says which diff the tour walks:

- `{"kind": "changelist"}` — your own uncommitted files (the changelist the app
  keeps for you). The usual choice.
- `{"kind": "worktree"}` — everything uncommitted in the checkout.
- `{"kind": "range", "base": "main", "head": "HEAD"}` — commits; pinned to the
  two SHAs they resolve to, so the tour never drifts.

Each step has an `id` (a short unique slug), a `title`, a markdown `body`, an
optional one-line `hoverTip`, an optional `kind` (`explain`, `context`, or
`caveat`), the file's `path` (and `oldPath` for a rename), a `side` (`new`, the
default, or `old`), and **exactly one anchor**:

| Anchor | Use it for |
|---|---|
| `match` (+ `lineCount`) | **Prefer this.** Text that appears exactly once on that side of the file — a signature, a distinctive line, or several lines. `lineCount` extends the step downward from the match. |
| `hunk` | The file's n-th change, 1-based. Good for "this whole change". |
| `lines: [start, end]` | Only when nothing else fits: counted lines break the moment the file moves. |
| `fileOnly: true` | A point about the whole file — and the only anchor for a binary or very large file. |

Removed code and deleted files are on the `old` side. A renamed file is named by
its new `path`, with `oldPath` beside it.

The answer carries `tourId`, each step's resolved lines, and `revealed`. The
Diff tab is docked without taking focus and **nothing plays until the owner
presses Start** — do not tell them it is playing. `revealed: false` only means
no window was showing the workspace; the tour is saved and they can open it
from the Diff viewer's tour menu.

## Writing it well

- **Order: foundations → behaviour → surface → tests.** Types and data first,
  then what uses them, then what a person sees, then what holds it in place.
- **Say why, not what.** The diff is on screen. A step that paraphrases the code
  wastes the owner's attention; a step that names the constraint behind it
  earns it.
- **One idea per step**, a few lines each. Five to twelve steps is a good tour;
  a long change is two tours, not a forty-step one.
- **Be honest about weak spots.** A `caveat` step for a known gap, a guess or a
  shortcut is worth more than a clean-looking tour. It is drawn as one.
- `context` is for code that did not change but is needed to follow the change.

## While it plays

- `tour_status` with `{tourId}` — which step the owner is on, what they have
  seen, which steps `moved` (the code changed after you wrote the tour and the
  lines could not be found again) or are `gone` (the file left the diff), and
  their recent questions.
- `tour_update` with `{tourId, …}` — `insertAfter: {after, steps}` adds steps
  (omit `after` to append; stream a long tour in batches, or add a detour that
  answers a question right after the step it is about), `replace` swaps steps by
  id, `remove` drops ids. New steps are resolved like `tour_create`.
- `tour_goto` with `{tourId, stepId}` — point the owner at a step, typically
  after answering a question. Their view moves only if they turned on "Follow
  agent"; otherwise they see a chip saying where you point. `moved: false` is
  not an error — `reason` says why.
- `tour_close` with `{tourId}` when the walkthrough is over.

## Questions

A question the owner asks from a step arrives in your terminal as one message,
starting with where it is from:

```
[Tour "Retry with jittered backoff" · step 3/8 "Stop early" · src/queue/retry.ts L23–24 (new)]
Why not keep the first error instead of the last one?
```

Answer it in the terminal. If the answer deserves to stay with the tour, add a
detour step after that one with `tour_update`, then `tour_goto` it. Questions
are typed in only when your turn has ended, so answering promptly and ending
your turn is what lets the next one through.
