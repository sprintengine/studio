---
name: backlog
description: Take, work, survey, or triage Multicode Backlog items — or work a whole epic end to end, in dependency order, with review and seam checks — keeping lifecycle status truthful throughout. Use when the user explicitly invokes the backlog skill, drags a backlog/ file into an agent terminal, asks the agent to pick up/survey/work a Backlog item or epic, or asks to triage/prune/review the backlog.
---

# Backlog

<!-- Keep the lifecycle rules in this skill in sync with
     resources/sprintengine/skills/multicode_backlog/SKILL.md (the Sprint
     Engine composed-Soul copy of the same contract). -->

<what-to-do>

Work a Multicode Backlog item as the intake brief for direct agent pickup, keeping the item's lifecycle status truthful in the Backlog panel the whole time. Items live as files under `backlog/` in the project root; each item's lifecycle and triage metadata live in that file's own **frontmatter** — `status`, `type`, `difficulty`, `criticality`, `risk`, and the up-pointing `epic:` slug — and that frontmatter is the source of truth. The object store `.multi-code/backlog/items.json` holds only app-owned churn (links, the star/highlight, module metadata, timestamps); you never touch it to change an item's status or triage.

The Backlog panel reads item status from the file's frontmatter, so keeping it current is part of the work, not optional bookkeeping. Whenever the real state of your work changes, call `backlog.update` for its `status` in the same step:

- **Starting**: set `in_progress` before implementation work begins.
- **Blocked on the user**: set `needs_input` the moment you stop to wait for a decision, missing information, or help only a human can provide — and state the specific question in your reply. A `needs_input` status with no stated question is incomplete.
- **Resuming**: set `in_progress` again once unblocked.
- **Finished**: set `completed` only when the work is genuinely complete and verified with real evidence. Never for partial work, and never on mocks, fixtures, or disconnected UI state.
- **Stopping incomplete**: leave the item `in_progress` and report the remaining work — never let it silently look finished or abandoned.

Creating an item needs no tool: write the markdown file under `backlog/` yourself (see Creating An Item below). For lifecycle and triage mutations on existing items, prefer the SprintEngine Studio MCP tools — `backlog.update`, `backlog.assign`, `backlog.work` — which validate schema, preserve omitted fields, write links through the app-owned store, and stamp `updated:` programmatically; never supply or calculate a timestamp. The tools target the project your agent was launched from automatically — pass `projectRoot` (absolute path) only when operating on a different folder or calling from outside a Studio-launched agent. If the Studio MCP is unavailable, edit the item's frontmatter directly using the same field vocabulary, and delete the `updated:` line instead of inventing a timestamp (file mtime then carries recency). `.multi-code/backlog/items.json` stays app-owned; never edit it. All paths passed to tools or written in replies must be project-root-relative.

</what-to-do>

<supporting-info>

## Invocation

The exact CLI invocation is adapter-specific. For example, slash-capable CLIs
may expose `/backlog`, while Codex uses explicit skill mention such as
`$backlog`. Once this skill is active, follow the modes below.

**With an item argument** (for example `backlog/<file>.md`, a dragged file path, or a named item):

1. Confirm the path is under `backlog/`. If it is not, refuse and say why — this skill only works Backlog items.
2. Read the item. It is the intake brief: the what, why, user impact, reproduction notes, references, and (optionally) an implementation plan or checklist. If the item carries implementation notes that conflict with the current codebase, the stated behaviour and the current codebase win.
3. Set the item `in_progress` in its frontmatter (see Updating An Item below) **before** starting implementation work.
4. Do the work, honouring whatever role or Soul you are already operating under. Follow the item's checklist if it has one, updating it as you go.
5. Verify and review before claiming completion — see Verifying The Work. This applies to a single item, not only to epics.

**With an epic argument** (`backlog/epics/<slug>.md`, or a named epic): see Working An Epic.

**Without an argument**: survey, then ask — never pick work silently.

1. List the item files under `backlog/` and read each one's frontmatter.
2. Exclude items whose status is `completed`, `archived`, or `in_progress`. Include epics: an epic is pickable as a whole (see Working An Epic), and presents as one entry with its open child count.
3. Rank the remainder: `ready` before `idea`, then higher `criticality` first, then lower `risk` first, then smaller `difficulty` first; items missing an axis rank after estimated ones at the same level.
4. Present a short ranked list (title, one-line intent, type/size/priority/risk when known) and ask the user which item to take. Once they choose, continue as if that item had been the argument.

**Triage the backlog** (`triage`, or "triage/prune/review the backlog"): assess every item against the current codebase, report, then ask before changing anything. Triage never deletes, completes, or re-statuses an item silently.

1. Read every non-archived item file under `backlog/` (including epics under `backlog/epics/`) and its frontmatter.
2. Read each item and judge it against the **current codebase** (and recent git history when useful). Sort each into:
   - **Worth doing now** — still relevant open work. Note a one-line reason it matters and roughly how it ranks.
   - **Already done** — the described behaviour already exists in the code. Recommend status `completed`.
   - **Outdated / no longer relevant** — the premise is gone, the code moved on, or another item/run supersedes it. Recommend deleting or archiving.
   - **Status drift** — the recorded `status` does not match reality (e.g. `in_progress`/`needs_input` with no live run or agent session backing it, or a linked run that has already finished). Recommend the truthful status.
   Base every judgement on what you actually find in the repo. If you cannot tell whether an item is still relevant, leave it under "worth doing now / needs a human look" — never recommend deletion on a guess.
3. Present one report grouped by those buckets. Each line: title, project-relative path (e.g. `backlog/example.md`), a one-line reason, and the proposed action. Do **not** mutate or delete anything yet.
4. Ask the user to confirm which recommendations to apply. Then apply **only** what they approve, leaving everything else untouched:
   - Status change (`completed`, `idea`, etc.) — call `backlog.update` (see Updating An Item below).
   - Archive — call `backlog.update` with `status: archived`.
   - Delete — there is no agent deletion tool; report the approved deletion for the user/UI instead of deleting the file directly.
   Report exactly what changed, in project-relative paths.

## Item Vocabulary

All lifecycle and triage fields are flat top-level frontmatter scalars; every axis is optional — leave one unset rather than guessing:

- `id`: a stable, workspace-global integer that is the item's durable identity — allocated once and **never changed** (not across re-type, rename, or re-triage). It is shown in the app as `<KEY>-<id>` (e.g. `MC-240`), where `KEY` is the per-workspace display key in `.multi-code/backlog/config.json`; cite items by that display id. The app assigns ids automatically on scan — new files omit `id:` and agents never allocate, reuse, renumber, or edit one.
- `type`: `epic`, `feature`, `bug`, `mockup`, or `spike` (a time-boxed investigation/decision item — the deliverable is a recommendation, not shipped behaviour). `epic` marks a grouping container; see Epics below. An unknown `type:` value is preserved as written and treated as a leaf item, never coerced.
- `difficulty`: t-shirt size `xs`, `s`, `m`, `l`, or `xl` (effort to build).
- `criticality`: `low`, `normal`, `high`, or `critical` (impact if missing).
- `risk`: `low`, `normal`, or `high` (likelihood the work goes sideways — a separate axis from effort).
- `status`: `idea`, `ready`, `in_progress`, `needs_input`, `completed`, or `archived`.
- `epic`: slug of the epic this item belongs to (see Epics below).
- `dependsOn`: prerequisite items as one flat comma-separated scalar (never a YAML list), e.g. `dependsOn: a-item, b-item`. Each entry is the prerequisite file's name stem — the same identifier scheme `epic:` uses. Only the dependent stores the edge; the app derives the reverse "blocks" view, and a `ready` item with unresolved prerequisites presents as Blocked on its own — never write `blocked` as a status.
- `mockups`: attached mockup files as one flat comma-separated scalar of project-relative, comma-free paths (canonical home `backlog/mockups/`), e.g. `mockups: backlog/mockups/2026-07-06-x.html`. Absolute paths and `..` escapes are invalid. A body-prose link like `Mockup: [x](mockups/x.html)` also surfaces read-only without being listed here.

`dependsOn` and `mockups` are not covered by `backlog.update` — set them when authoring the file, or edit the frontmatter line directly (leave `updated:` alone or delete it, as with any direct edit).

Legacy files may carry a single nested `backlog:` block or the aliases `size` → `difficulty`, `priority` → `criticality`, `itemType`/`backlog_type` → `type`; these are still read. New and edited files use the flat top-level keys above. The star/highlight is owned only by the object store and is never written to frontmatter.

## Updating An Item

The item's Markdown frontmatter remains the source of truth; `backlog.update` is the preferred mutator. Pass the project-relative item path and only the fields that truly change (`status`, `type`, `difficulty`, `criticality`, `risk`, or `epic`). The server validates values, preserves the body and omitted fields, and records the exact update instant — do not pass `updated`, touch `items.json`, or compute an id/hash. Direct frontmatter editing is the fallback when the gateway is unavailable: change only the fields that changed and delete the `updated:` line.

## Creating An Item

Write the markdown file yourself — creation involves no tool:

1. Write `backlog/<slug>.md` (epics: `backlog/epics/<slug>.md`), choosing a filename slug from the title that doesn't already exist.
2. Start with a frontmatter block carrying only grounded fields — `status` (new items normally start as `idea`), `type`, and any triage axes you can honestly estimate — then a `# Title` heading and the body: the what, why, user impact, and references.
3. Omit `id:` and `updated:` entirely. The app allocates the numeric id on its next scan (collision-safe, even with concurrent writers) and registers the item; recency falls back to file mtime until a tool mutation stamps `updated:`.

```markdown
---
status: idea
type: bug
criticality: high
---

# Title of the item

What, why, user impact, reproduction notes.
```

## Epics

An **epic** groups related items. It is itself a file at `backlog/epics/<slug>.md` with `type: epic`; the `<slug>` is the filename stem (e.g. `backlog/epics/auth-revamp.md` → slug `auth-revamp`) and its title is the first `# Heading`. Membership is **stored up, derived down** — the only stored relationship is each child's `epic:` field, so the grouping can never desync:

- **Assign** an item to an epic: call `backlog.update` with `epic: <slug>` on the child.
- **Remove** an item from its epic: call `backlog.update` with `epic: null` on the child.
- **Create** an epic: write `backlog/epics/<slug>.md` with `type: epic` frontmatter and a `# Title` heading, then set `epic: <slug>` on each member through `backlog.update`.
- **Enumerate** an epic's children: `grep -l "^epic: <slug>$" backlog/*.md`.
- **Completion**: an epic is `completed` only when every one of its children is `completed`; never mark an epic `completed` while any child is still open. The status is **derived** — never write one onto the epic file yourself.
- **Working** an epic end to end: see Working An Epic below.

## Working An Epic

An epic is pickable as a whole: you implement every open child, in dependency
order, then verify the result against the epic's own purpose. This is a serial
single-agent run — it does not spawn implementation agents.

1. **Read the epic file first.** Its heading and its "why this exists" prose are
   the outcome you are working toward. Do not restate them anywhere; you will be
   asked to judge the finished work against them at the end.
2. **Enumerate children**: `grep -l "^epic: <slug>$" backlog/*.md`. Read every
   one in full. Each child is its own brief — never paraphrase a child into a
   plan file, and never write a task card that restates it.
3. **Skip children that are not workable**: `completed`, `archived`, and
   `idea` (a deferred item is not part of this run — only `completed` and
   `archived` are terminal, so pulling one in leaves the epic permanently short
   of done). Say in your report which you skipped and why.
4. **Order by `dependsOn`.** Each child's `dependsOn` names its prerequisites by
   filename stem. Work the un-gated children first, then those they unblock.
   Where the frontmatter declares no order, you own the sequencing — and you own
   safe concurrency regardless: two changes landing in the same file need an
   order even when neither declares one.
5. **Split if the epic is large.** More than about five workable children, or a
   contract-wide rename sharing the run with feature work, is two runs. Do the
   prerequisite half, report, and let the rest be picked up separately. A
   half-applied rename is the worst outcome available.
6. **Isolate the work** when a project's checkout is shared with other sessions:
   `git worktree add -b <branch> <path> main`, and work there. Branching inside a
   shared checkout moves other sessions' `HEAD`.
7. **Children drift — fix them in place.** These items were written before the
   code moved. Where a child's claim no longer matches the codebase, correct the
   child file itself, then implement the corrected version, and say so in your
   report. Expect to find at least one; this is the highest-value thing you do.
8. Set each child `in_progress` as you start it and `completed` as you finish it.
   **Never set a status on the epic file** — an epic derives completion from its
   children.

### The ledger

Keep a running record at `.agent-work/<slug>-ledger.md`, written as you go, not
at the end. It is the only state that survives you: if your context is exhausted
or the run is interrupted, a successor reads it and knows exactly where things
stand. Commits alone do not record that a review pass ran, or that a criterion
failed.

```markdown
# <epic title> — ledger
Branch: <branch>   Worktree: <path>

## Items
- [x] MC-1234 <slug> — done, corrected in place: <what was stale>
- [ ] MC-1235 <slug> — in progress
- [ ] MC-1236 <slug> — blocked on 1235

## Verification
- [x] engine suite — 834 passed (baseline 834)
- [ ] typecheck

## Reviews
- [x] spec — 2 findings, both fixed
- [ ] seam
```

Update it at every item transition and after every review pass. When you finish,
it is your report.

## Verifying The Work

This applies to every mode — a single item as much as an epic. Scale it down for
small work; do not skip it.

**Establish the facts yourself, first.** Read the project's own traps and gates
before planning: `CLAUDE.md`, the knowledge base if the project has one, and
whatever test-budget or verification scripts it declares. Record the *current*
baseline (test counts, any byte ceilings) at the start of the run and compare
against it at the end. Never trust a number quoted in a brief, an item, or a
previous ledger — they go stale, and a stale number sends you looking for a
regression you did not cause.

**Verification**: run the project's own gates — its typecheck, its test command,
its verification script. If a test fails, reproduce it on the base branch before
assuming you caused it.

**Review passes.** Prefer **one subagent per pass, each with fresh context**,
given the diff and the items but not your reasoning. A subagent does not inherit
your conversation, which is the entire point: the context that wrote the code
re-runs the reasoning that produced the bug. Run them concurrently where the
harness allows. Reviewers **report findings; they never edit** — you apply the
fixes, so concurrent agents never collide on the same files.

- **Spec** — check each item's acceptance criteria literally. Run the commands
  the items name; do not eyeball them.
- **Structural** — dead references, orphans, imports left behind. Anything that
  should have died with a change and did not, and anything that died that
  should not have.
- **QA** — the project's full verification, plus a restart/smoke check if it has
  a long-running process.
- **UI/UX** — only when UI actually changed. Conform to the project's design
  system rather than inventing styles. Build to a referenced mockup; author one
  only where the item says to. If no UI changed, say so instead of inventing a
  pass.

**Seam review — when the run covers more than one item.** This is where the real
defects have been. For each pair of items touching the same file or contract,
produce a command, test, or reproduction whose output proves they work
*together*. "I read both sides and they look consistent" is not evidence. Encode
them as tests labelled `SEAM:` so they keep holding after you leave.

Run the seam review as **one** reviewer seeing the whole diff — never fan it out
per item. Subagents cannot see each other's context or share findings, and a
seam is by definition cross-item; splitting it destroys the pass.

**Adversarial pass.** One reviewer, fresh context, the whole diff: *assume there
is a flaw and find it.* The shapes that keep recurring:

- Something that appears to enforce, verify, or update, but whose condition can
  never fire, or can be satisfied accidentally.
- A contract honoured by one of its callers and silently dropped by another.
- A test that passes while proving nothing.

**Judge the whole against the epic's purpose.** Individually-correct items can
add up to something that does not achieve what the epic set out to do. Say
plainly whether it does.

**Report honestly.** What landed, what did not and why, which items you
corrected in place, the verbatim result of each verification command, each seam
and how you proved it, and anything you judged out of scope. If you finished
only part of it, say exactly where you stopped and leave those items
`in_progress`. A truthful partial result is worth more than a tidy summary.

## Recording The Working Agent

When a typed pickup was not already linked by drag/drop or `backlog.work`, call `backlog.assign` with the item path and the real `MULTICODE_AGENT_ID`; use `MULTICODE_AGENT_NAME` as the label when available. Never invent identity. If the environment has no agent id, skip attribution. The app owns the object-store id, link shape, and timestamp; never edit `.multi-code/backlog/items.json` yourself.

</supporting-info>
