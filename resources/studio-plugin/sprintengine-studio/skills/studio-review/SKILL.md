---
name: studio-review
description: Read and write SprintEngine Studio code reviews through the review_* tools - list pending reviews, read a review's change set, read the current walkthrough, and submit a new one. Use when a terminal is started as the Review guide for a review, when asked to prepare, refresh or re-run a review walkthrough or brief, when asked which reviews are waiting, or when a reviewer asks a question about the change under review.
---

# Review

Studio's Reviews door holds a *change set* (the normalised diff) and a *brief*
(the walkthrough a human reads before reviewing it). Four tools address both.
Every one takes `{reviewId, projectRoot}`; `projectRoot` is an absolute path
that must be a project **open in this app**, and is confirmed against the app's
open roots before any file is touched.

Two rules bind everything here, and a validator enforces the first one:

1. **The guide explains; it never judges.** There is no finding, severity or
   suggested-patch shape anywhere in a brief. Annotation kinds are explanation
   kinds — `explain`, `context`, `knowledge` — and an attempt to smuggle a
   severity-like kind is rejected.
2. **Reviewer state lives outside the brief.** Files marked read, the chosen
   diff view and the human's comments are workspace state, not brief content,
   so regenerating a brief never destroys a reviewer's progress.

## The order

`review_list_pending` first. It lists reviews across every open project, each
with its `reviewId`, `projectRoot`, change `source`, and `hasBrief` — which is
what tells you whether this is a first run or an incremental re-run. **If the
prompt does not name a review, call this and ask the reviewer which one to walk
rather than picking for them.**

`review_get_changeset` next. It returns the change set in full with no silent
truncation: files, per-file hunks, base and head refs and SHAs, and the source
kind. The source's absolute repository path is stripped before it reaches you,
so do not expect one and never reconstruct one.

`review_get_brief` when `hasBrief` was true. It returns the stored walkthrough,
or null when none exists or the stored one is unusable. Read it before a re-run
so you can carry unchanged steps across rather than rewriting a brief the
reviewer has already partly read.

`review_submit_brief` last, with `{reviewId, projectRoot, brief}`. Pass the
brief as an **object, never a JSON string** — a string is refused at the
boundary.

## Writing the brief

The full contract — `ReviewBrief`, `ReviewStep`, `ReviewAnnotation`,
`ReviewAnchor`, `ChangeMap`, `KnowledgeRef` and the validation rules — is the
`review-guide` skill, which carries the schema verbatim as its output spec. Read
it before writing a brief; this skill does not restate it, and a restatement
would drift.

The app installs `review-guide` into a workspace when it starts a Review guide
terminal, so if you were started as one it is beside this skill. If it is not
there, you were started some other way: say so rather than inventing the parts
of the schema you cannot see. What follows is the minimum needed to build a
brief the validator accepts — enough to work without `review-guide`, not a
substitute for it.

The shape in one breath: `schemaVersion: 1`, a `changeSetId` equal to the `id`
of the change set you walked — that field, not the `reviewId`, or the
cross-check answers `brief_mismatch` — a non-empty `generatedAt`, an `overview`, ordered `steps` each
with a `narrative` and per-file `why` lines and line-anchored `annotations`, the
`knowledgeRefs` you actually consulted (`[]` when you consulted none), and an
honest `coverage` holding `assignedPaths` and `unassignedPaths`, both arrays of
repo-relative path strings and both required even when empty. At the top
level `headSha` and `changeMap` are the only optional members — omitting any of
the others is `brief_invalid`, and `generatedAt` is the one easiest to forget.

One level down, where a brief is most often rejected:

- **overview**: `intent`, `blastRadius` and `readingGuide`, all non-empty
  strings. `complexity` is OPTIONAL — a brief may carry no judgment of it — but
  when present it must be `low`, `medium` or `high` and nothing else.
- **step**: `id` (a slug), `order` (a non-negative integer — required, and the
  one this list used to omit), `title`, `narrative`, `files`, `annotations`.
- **step.files[]**: `path` and `why` (at most 200 characters). `readingNote` is
  optional and is `read-closely` or `mechanical-skim`.
- **annotation**: `id`, `path`, `anchor`, `kind`, `title`, `summary`, and
  `hoverTip` (at most 200 characters). `kind` is `explain`, `context` or
  `knowledge` — those three and nothing else. `detail` and `knowledgeRefs` are
  optional, and an annotation's `knowledgeRefs` is an array of plain STRINGS,
  not of `{note, reason}` objects like the brief's own — the two fields share a
  name and not a shape.
- **anchor**: `side` (`new` or `old`), `startLine` and `endLine`, both positive
  integers with `endLine >= startLine`. Line numbers are counted by walking the
  hunk from its `newStart`/`oldStart`, advancing only on the lines that exist on
  that side, and the cross-check rejects an anchor outside the file's own hunk
  extent.
- **knowledgeRefs[]**: `{note, reason}`, both non-empty.

Every non-binary file in the change set belongs to exactly one step, or is named
in `coverage.unassignedPaths`. Unassigned paths render as a visible warning to
the reviewer, which is the point: an incomplete walkthrough that says so is
useful, and one that quietly drops files is not.

Step ids are slugs, unique within the brief, and **stable across re-runs when
the content has not changed** — that stability is what lets an incremental
re-run preserve a reviewer's place.

Never put an absolute machine path in a brief. A leak guard rejects the whole
submission if you do.

## When a submission is refused

`review_submit_brief` validates server-side in a fixed order and writes nothing
until all three pass: schema shape, then a cross-check against the change set
loaded on the server, then the machine-path leak guard.

A failure returns **every** validator message, not the first. Fix all of them in
one pass and resubmit; a retry loop that fixes one message per round is wasting
the reviewer's time. `brief_invalid` is a shape problem, `brief_mismatch` means
you named a file, path or change set id the server's change set does not hold,
and `brief_path_leak` names the offending absolute path.

`no_changeset` means nothing has been ingested for this review yet — that is an
answer to report, not a state to retry into. `unknown_project` means the project
is not open in this app; say so and ask for it to be opened rather than guessing
another path. `changeset_unreadable` and `path_leak_blocked` are the server
withholding something; report the code and stop.

A valid brief is written atomically and an open Reviews door reloads it with no
restart, so there is no second "publish" step to perform.

## Answering a reviewer's question

When a reviewer asks about the change rather than asking for a walkthrough, read
the change set and the current brief and answer from them. Do not submit a new
brief to answer a question — a submission replaces the walkthrough the reviewer
is reading. Submit only when you were asked to prepare or refresh one.
