# Review workspace schemas

The review workspace is schema-driven: the guide agent emits a **brief**, the
renderer projects it, the human writes **comments**, and the sync layer posts
them. Neither side ever sees provider-specific payloads or free-text
intermediate shapes. Every rendered surface is a projection of validated JSON.

These are the canonical contracts. The guide agent (MC-1679) receives this
document verbatim as its output spec, so keep the shapes and rules here in sync
with `src/shared/review/`.

Two rules bind the whole design:

1. **The guide explains; it never judges.** There is deliberately **no**
   finding / severity / suggested-patch shape anywhere in these contracts.
   Annotation kinds are explanation kinds (`explain` / `context` / `knowledge`)
   only. A validator rejects any attempt to smuggle a severity-like kind.
2. **Reviewer state lives outside the brief.** The brief is immutable guide
   output. Files marked read, the chosen diff view, and the human's comments are
   `ReviewWorkspaceState` — so re-generating the brief never loses progress.

All validators are hand-rolled TypeScript (no zod / json-schema) returning
`{ ok: true; value } | { ok: false; errors: string[] }` with path-qualified
error strings, and are **tolerant of unknown keys** (forward compat — unknown
fields are preserved, never rejected). The module is node-free: nothing under
`src/shared/review/` imports from `src/main/` or Electron.

Exports:

- `src/shared/review/changeset.ts` — `validateReviewChangeSet`
- `src/shared/review/brief.ts` — `validateReviewBrief`, `checkBriefMatchesChangeSet`
- `src/shared/review/comments.ts` — `validateReviewComment`, `validateReviewWorkspaceState`
- `src/shared/review/anchors.ts` — `validateAnchor`, `isAnchorWithinExtent`, `shiftAnchor`
- `src/shared/review/pr-url.ts` — `parsePullRequestUrl`, `ParsedPullRequest`
- `src/shared/review/brief-run-events.ts` — `BRIEF_RUN_EVENT_TOPIC`

Beside them, and part of the same contract without being barrelled:
`guards.ts` (the shared validator primitives), `pathSafety.ts` (`homePathLeak`
— a review artifact carrying an absolute home path is rejected), and
`review-state.ts` (`ReviewProgressState`, `REVIEW_STATE_PRESENTATION`).

## ReviewChangeSet

The normalized diff every surface projects. Produced by ingestion (local branch
/ patch, or a fetched PR); never rendered raw.

```ts
interface ReviewChangeSet {
  schemaVersion: 1
  id: string                       // stable content hash of (source identity + headSha/patch digest)
  source: ReviewSource
  title: string                    // PR title, branch name, or patch label
  description?: string             // PR body when available
  baseRef: string
  baseSha?: string
  headRef?: string
  headSha?: string                 // absent only for pasted patches
  files: ChangeSetFile[]
  stats: { files: number; additions: number; deletions: number }
  fetchedAt: string                // ISO-8601
}

type ReviewSource =
  | { kind: 'pull-request'; provider: 'github' | 'github-enterprise'
      host: string; owner: string; repo: string; number: number; url: string }
  | { kind: 'branch'; repoRoot: string; baseRef: string; headRef: string }
  | { kind: 'patch'; label?: string }
  // 'bitbucket' joins the provider union later; the validator rejects unknown
  // providers explicitly, never silently passes them.

interface ChangeSetFile {
  path: string
  oldPath?: string                 // required when status is 'renamed'
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  binary: boolean
  additions: number
  deletions: number
  hunks: ChangeSetHunk[]           // empty when binary
}

interface ChangeSetHunk {
  oldStart: number; oldLines: number
  newStart: number; newLines: number
  lines: Array<{ kind: 'context' | 'add' | 'del'; text: string }>
}
```

## ReviewBrief

The guide's walkthrough of a changeset: semantic steps ordered for
understanding, per-file *why*, narration, line-anchored annotations, an optional
change map, and honest coverage accounting.

```ts
interface ReviewBrief {
  schemaVersion: 1
  changeSetId: string              // must equal the ReviewChangeSet.id it walks through
  headSha?: string                 // freshness key, copied at generation time
  generatedAt: string
  overview: {
    intent: string                 // what the change is trying to do, plain language
    blastRadius: string            // what it touches / what could break
    readingGuide: string           // how the steps are ordered and why
    complexity?: 'low' | 'medium' | 'high'   // optional: absent is legal, and a brief
                                             // degraded from a change set alone states none
  }
  steps: ReviewStep[]              // every non-binary file in exactly one step (or coverage.unassignedPaths)
  changeMap?: ChangeMap            // optional entity map for the Overview
  knowledgeRefs: KnowledgeRef[]    // knowledge notes the guide actually consulted
  coverage: {
    assignedPaths: string[]
    unassignedPaths: string[]      // rendered as a visible warning when non-empty
  }
}

interface ReviewStep {
  id: string                       // slug, unique within brief; stable across re-runs when content unchanged
  order: number
  title: string
  narrative: string                // plain-language paragraph; may cite [[note-name]]
  files: Array<{
    path: string                   // must exist in the changeset
    why: string                    // one sentence, <= 200 chars, why this file changed
    readingNote?: 'read-closely' | 'mechanical-skim'   // guidance, not judgment
  }>
  annotations: ReviewAnnotation[]
}

interface ReviewAnnotation {
  id: string
  path: string                     // must exist in the changeset
  anchor: ReviewAnchor
  kind: 'explain' | 'context' | 'knowledge'   // explanation kinds only — no issue/severity kinds
  title: string
  summary: string                  // 1–2 sentences, always visible in the summaries panel
  detail?: string
  hoverTip: string                 // ONE sentence, <= 200 chars; popover on the anchored lines
  knowledgeRefs?: string[]
}

interface KnowledgeRef { note: string; reason: string }

interface ChangeMap {
  nodes: Array<{
    id: string; label: string      // label <= 40 chars
    sublabel?: string              // <= 48 chars, mono detail
    stepId: string                 // must reference a brief step
    kind: 'data' | 'api' | 'ui' | 'job' | 'test' | 'config' | 'other'
  }>
  edges: Array<{ from: string; to: string; label?: string }>  // endpoints must be node ids; label <= 16 chars
  deployNote?: string
}
```

## ReviewAnchor

A contiguous span of lines on one side of the diff. Anchors position hover tips,
annotations, and comments; re-runs re-project them through `shiftAnchor`.

```ts
interface ReviewAnchor {
  side: 'new' | 'old'
  startLine: number                // 1-based, inclusive, positive integer
  endLine: number                  // >= startLine
  anchoredAtSha?: string           // sha the anchor was computed against (re-anchoring input)
}
```

## ReviewComment + ReviewWorkspaceState

The human's review. Mutable workspace state, never part of the brief.

```ts
interface ReviewComment {
  id: string
  path: string
  anchor: ReviewAnchor
  body: string                     // markdown, authored by the human
  createdAt: string
  sync:
    | { state: 'pending' }         // drafted locally, part of the pending review
    | { state: 'posting' }
    | { state: 'posted'; url: string; postedAt: string }
    | { state: 'failed'; error: string }   // stays pending; retry allowed
  anchorStatus?: 'moved'           // set by a freshness re-run when the anchored
                                   // range vanished; the comment is kept for
                                   // re-review and never posted from this state
}

interface ReviewWorkspaceState {
  schemaVersion: 1
  changeSetId: string
  readFiles: string[]              // paths marked read
  activeStepId?: string
  diffView: 'side-by-side' | 'inline'
  comments: ReviewComment[]
}
```

## Validation rules

Enforced by the validators; an invalid brief is a visible failure, never a
partial silent render.

- `schemaVersion` exact-match; an unknown version errors naming the version.
- Every enum field rejects unknown values, naming the offending value — no
  silent pass-through of an unrecognized kind / status / provider, and no
  severity-like kind smuggled into an explanation field.
- Anchors: `side` is `new`/`old`, lines are positive integers, `endLine >=
  startLine`.
- `hoverTip` and `files[].why`: required, non-empty, `<= 200` chars.
- `changeMap` (when present): node ids unique; every edge endpoint references an
  existing node; every node `stepId` references an existing step; label /
  sublabel / edge-label length caps; `<= 14` nodes, `<= 20` edges.
- Step ids are unique within a brief.
- A file marked `binary: true` carries no hunks.
- No artifact may carry an absolute home path (`homePathLeak`).
- Unknown extra keys are tolerated (forward compat).

### checkBriefMatchesChangeSet(brief, changeset)

Cross-checks a brief against the changeset it walks (both assumed to have passed
their own validators):

- `brief.changeSetId` equals `changeset.id`.
- Every `step.files[].path` and every `annotation.path` exists in the changeset.
- Every annotation anchor sits inside its file's line extent for the anchor's
  side (an out-of-range anchor is caught).
- Coverage is honest: `coverage.assignedPaths` matches the paths the steps
  assign; every non-binary changed file is assigned to **exactly one** step or
  listed in `coverage.unassignedPaths`. An unassigned changed file (silent drop)
  and a double-assigned path are both caught. Binary files need no assignment.
