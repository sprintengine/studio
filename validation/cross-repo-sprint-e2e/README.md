# Cross-Repo Sprint E2E

Supervised end-to-end validation for sprints that span more than one repository
(MC-1610: a run declares a set of projects, every task targets exactly one).

Unit tests, typecheck and gates cover the seams in isolation. They cannot prove
that the built app creates two worktrees, routes a real agent's terminal into
the right one, lands its commit in that project's index, opens one pull request
per project with correct companion links, and refuses an out-of-order merge.
This checklist is how that gets proven, by a person, against two real repos.

The contract this validates is the sprint worktree model (trees, repos list,
commits, orphans) and the pull-request model (PRs, merge order, chips) — the run
store shapes in `docs/sprintengine-schema.md` and the mutation boundary in
`docs/sprintengine-cli.md`. When a step here and those disagree, they are the
contract and this checklist is what is wrong — unless the app disagrees with
both, which is the finding.

## Why This Is Not Executed By The Run That Wrote It

**Read this before scheduling the session. Executing early destroys work.**

The run that authored this checklist could not also execute it, and this is a
property of the change, not an oversight:

- That run's own store is `schemaVersion: 3` (`run.yaml:1`).
- This work bumps `RUN_SCHEMA_VERSION` to `4` (`sprintengine_core/store.py:88`).
- v3 stores are **rejected, never migrated** — by policy, not by omission. The
  store raises `RunStoreVersionError`: *"Unsupported Sprint Engine run store
  (schemaVersion 3, expected 4) … is never migrated. Delete `<team-dir>` and
  re-run the sprint."*
- A worktree run executes the **main checkout's** engine code — the worktree
  isolates source edits, not the running engine. So while the branch is
  unmerged the bump is inert and in-flight v3 runs stay alive.
- This E2E needs the built app on **v4** engine code. Restarting the app on v4
  makes every fresh engine process reject every v3 store, wedging those runs
  mid-flight — the failure that stranded the `sprint-engine-work-queue` run on
  2026-07-15 (3 ready tasks, nothing spawning).

So execution is deliberately **post-merge**, in this order:

1. **Land** the `sprintengine/multi-repo-sprints` branch on `main`.
2. **Restart** the app, so engine processes pick up v4 code.
3. **Create a fresh run** — only then. Never point a v4 engine at a v3 store.

Before restarting, expect every in-flight sprint to need cancel + recreate,
including the one that produced this branch. Finish or abandon them first;
there is no migration and there is no recovery path afterwards.

## Headless Limitation And Partial Evidence

There is no CLI run-driver — a sprint is driven by the app's supervisor
spawning real agent terminals, and it cannot be driven start-to-finish from a
script. This is a **supervised session**: a person runs the app, watches, and
records what they see.

Per the standing E2E policy, that means:

- Record **partial evidence**. A step you could not reach is `not reached`, not
  a pass. A step you reached but could not confirm is `unverified`, not a pass.
- Never infer a downstream step from an upstream one. "PRs opened, so the
  bodies must be linked" is not evidence of linked bodies.
- Stop and record rather than improvise around a blocked step, then escalate
  to the user with what you have — the blocker is the result.
- Do not weaken a step to make it pass. A step that cannot be run as written is
  a finding about the step or the product, and either is worth knowing.

## Preflight

- [ ] Branch merged to `main`; app restarted since the merge.
- [ ] The `multicode-mobile` checkout sits beside the `multicode` workspace
      (`../multicode-mobile` from it) and is its own git root, outside the
      workspace: `git -C ../multicode-mobile rev-parse --is-inside-work-tree` →
      `true`. Paths here are written relative to the workspace, the way
      `run.yaml` stores them; substitute your own checkout locations.
- [ ] `gh auth status` succeeds for `sprintengine`.
- [ ] Working trees of both repos are clean. An orphan step cannot be read
      against a dirty baseline.

### Use A Throwaway Base In Both Repos

**These are real repositories with real remotes** (`sprintengine/studio`,
`sprintengine/mobile-app`). This session pushes **real branches** and
opens **real pull requests** against both, and A11 **merges** them to prove
merge order. Merging throwaway sprint commits into `main` is not acceptable, so
do not let `main` be the base.

A run has no base-ref flag: each repo's base is **whatever branch that repo has
checked out when the run is created** (`default_base_ref`). That is the lever —
set it deliberately rather than discovering it:

- [ ] In **both** repos, create and check out a throwaway base off the current
      default, and push it:

  ```bash
  git checkout -b e2e/multi-repo-base
  git push -u origin e2e/multi-repo-base
  ```

- [ ] Confirm `git branch --show-current` reads `e2e/multi-repo-base` in both
      **before** creating the run.
- [ ] After creation, confirm each `vcs.repos[].baseRef` is
      `e2e/multi-repo-base` — **not** `main`. If either reads `main`, stop and
      fix it: A11 would merge into `main`.

Every PR then targets the throwaway base, merging is harmless, and Cleanup
deletes the bases. Budget for that cleanup before starting.

## Scenario A — Two-Repo Run

The load-bearing scenario: `multicode` (primary) + `multicode-mobile`
(sibling), a cross-repo dependency, driven to completion.

### A1 · Creation

- [ ] New workspace wizard, folder = the `multicode` checkout, worktree mode on
      ("Run in an isolated git worktree").
- [ ] The run-settings card offers **"Also changes these projects"**, listing
      sibling directories that are git repos of their own. `multicode-mobile`
      is offered; a non-git sibling is not.
- [ ] Default is **none** selected. Select `multicode-mobile`.
- [ ] Turning worktree mode **off** hides the picker and clears the selection
      (the engine refuses `--repo` without `--use-worktrees`).
- [ ] The picker names projects in plain language — never `repoId` or `vcs`.

### A2 · Declaration

- [ ] `run.yaml` has `schemaVersion: 4` and `vcs.repos` with two entries.
- [ ] Entry zero is the primary, `root: "."`.
- [ ] The sibling's `root` is stored **workspace-relative** (e.g.
      `../multicode-mobile`) — no absolute path, so the store stays
      machine-independent.
- [ ] No `vcs.repoRoot` key (retired by this work).
- [ ] Re-opening run settings shows the projects **read-only** — declared once
      at creation, immutable after.

### A3 · Worktrees

- [ ] Primary tree at `.multi-code/sprintengine/<team>/worktree`.
- [ ] Sibling tree at `.multi-code/sprintengine/<team>/worktree-multicode-mobile`
      — beside the primary, under the same run dir.
- [ ] Both are on branch `sprintengine/<team>`, each created from its **own**
      repo root (`git -C ../multicode-mobile worktree list` shows the sibling
      tree — it is registered in the mobile repo, not the primary).
- [ ] Each entry's `status` reads `ready`.

### A4 · Cross-Repo Plan

Plan a producer → consumer pair, so the merge order has something to say:

- [ ] A task targeting `primary` that changes a protocol/contract file.
- [ ] A task targeting `multicode-mobile` that consumes it, with `dependsOn`
      naming the primary task.
- [ ] A task created with an **undeclared** repo id is refused, and the error
      **names the declared projects**.
- [ ] A repo-level dependency **loop** (add a reverse cross-repo edge) is
      refused at authoring time, naming the loop (`primary → multicode-mobile →
      primary`). Remove the edge afterwards.

### A5 · Execution And Terminal Routing

- [ ] The mobile task's agent terminal starts in the **sibling** worktree
      (`pwd` inside it, not the primary tree, not the workspace root).
- [ ] Its worker prompt lists **both** declared projects (id, worktree, branch)
      and states the task's single target repo.
- [ ] The no-`cd` rule is present, restated per repo.
- [ ] Drive both tasks to `done`.

### A6 · Per-Repo Commits

- [ ] The mobile task's commit lands in the **mobile** repo's history, not the
      primary's.
- [ ] `vcs.repos[mobile].lastCommitSha` is set; the primary entry's
      `lastCommitSha` is **unchanged** by the sibling's commit.
- [ ] Commits stage only owned + declared paths (no `git add -A` sweep).
- [ ] Two projects commit **concurrently** without cross-blocking — the lock is
      per repo (`runner/git.commit.<repoId>.lock`), so only same-project agents
      wait on each other. Overlap two tasks in different repos to see it.
- [ ] `sprintengine vcs status` returns one block per declared repo under
      `repos`, with the top-level fields still describing the primary.

### A7 · Sibling Orphan Block

The invariant: orphan scans read ownership from the tasks targeting **that**
repo, and paths are repo-relative.

- [ ] Create an untracked file in the **sibling** tree, **beside** the mobile
      task's owned paths (same directory) but owned by no task. `task.publish`
      for that task **refuses**, naming the path. The publish guard is
      task-*adjacent*: it scans the parent directories of the task's own owned
      paths, so an orphan dropped in an unrelated corner of the tree will not
      trip it. If nothing blocks, check where you put the file before filing a
      discrepancy.
- [ ] The same orphan does **not** block a task publishing in the **primary**
      tree — a task never blocks on another project's tree.
- [ ] Same-relative-path check: a primary task owning `src/x.ts` does **not**
      excuse an orphaned `src/x.ts` in the mobile tree.
- [ ] Run completion blocks with `completion_blocked` on an orphan in **any**
      declared tree, **naming the project** (`orphanedByRepo: [{repo, path}]`).
- [ ] Clean up the orphans and confirm completion proceeds.

### A8 · Respawn Worktree Affinity

A task's `repo` — not the agent's history — is the authority on the tree its
session opens in.

- [ ] Let a **mobile** task's lease expire (or kill its terminal) so the pool
      respawns the owner.
- [ ] The respawned session's cwd is the **mobile** worktree — the revival
      spawns into the repo of the task it is revived **for**, not the repo the
      dead agent happened to be in.
- [ ] The task's lease carries its repo, and the worker view shows it, so the
      (role, repo) queue filter, the commit tree, and the diff evidence agree.
- [ ] A live **primary** developer does **not** satisfy the mobile queue: with
      a developer working in the primary tree and a ready mobile developer
      task, the pool still spawns a **mobile** session. (A desktop developer
      can never claim a mobile task, so it must not count as covering it.)
- [ ] The agent-cap is the run's **one global limit** — repo scopes selection,
      it is not a per-repo budget. Two projects must not double the cap.
- [ ] Spawn fallback: remove a sibling worktree while a session is persisted
      against it, then respawn. The spawn redirects into the **sibling repo's
      own root** — never the workspace root, which is a different project's
      tree. Persisted `agent.execution` is untouched.

### A9 · Pull Requests

- [ ] Run summary offers **"Open pull requests"** (plural — a single-repo run
      says "Open pull request"). It opens **one PR per declared repo**, each
      pushed to its own `origin`/`baseRef` from its own worktree.
- [ ] Each body's task table lists only the tasks targeting **that** repo.
- [ ] Each body has a **`## Companion pull requests`** section linking the
      sibling PR **in merge order, with the reason** — the producer repo first
      ("Work in **X** builds on work in **Y**, so **Y** has to merge first").
- [ ] Projects are named by **directory name** (`multicode-mobile`), never by
      repo id.
- [ ] Re-run `vcs pr`. It is **idempotent**: no second PR, and bodies
      **re-sync** (rebuilt whole from run state) rather than stacking a second
      companion section.
- [ ] **Partial success survives.** Force the sibling's PR to fail while the
      primary's succeeds, using a local, reversible break — in the **sibling
      worktree only**, point its remote at nothing
      (`git remote set-url origin /dev/null`), open the PRs, then restore it.
      Do not touch account or repository permissions to stage this. The failed
      repo keeps `status: failed` and its own `pullRequestError`; the other
      repo's PR is **not** rolled back. The action re-offers as **"Open
      remaining pull requests"** and re-running opens **only** the missing one.
      This is the trap the code calls out by name: reading the primary's URL
      alone would retire the button and strand the failed project.
- [ ] A declared project the run never committed to is **skipped** — no empty
      PR. (Declare a third repo that no task targets, or confirm on a run where
      one repo went untouched.)
- [ ] A repo that already **has** a PR is never re-judged on its commits —
      post-merge its commits are its base, and re-running must not drop it from
      its companions' bodies.

### A10 · Surfaces

- [ ] **Git panel** offers a per-project picker (labelled **"Project"**), one
      option per declared repo named by directory; each scope reads its own
      tree's status. Confirm each project has its **own commit draft** — typing
      a message under one project must not appear under the other.
- [ ] **PR chips**: one chip per declared repo on the board header and the
      run-summary verdict, labelled by project, each colored by **that repo's
      own** merge state (merged purple / closed muted / open accent).
- [ ] A project whose PR is missing or failed renders a **muted non-link chip
      naming it** — never dropped from the row.
- [ ] **Glyph**: while one project is merged and the other is not, the run does
      **not** read as merged. The label names what is left ("Ready for review ·
      1 project left to merge"). This is the regression that matters — the flat
      `vcs.pullRequestState` is the primary's alone.
- [ ] **Backlog item**: one PR link per repo. The primary keeps the bare link
      id; the sibling's is suffixed. Labels name the project only because this
      run spans more than one. A re-run **replaces** each link, never stacks.

### A11 · Merge Order

- [ ] `sprintengine vcs pr-merge --repo multicode-mobile` — while the producer
      (`primary`) is unmerged — is **refused**, naming the projects that must
      merge first by directory name.
- [ ] Re-confirm both PRs target `e2e/multi-repo-base`, then merge the producer
      and the consumer in that order; both succeed. **Do not run this step if
      either PR targets `main`** — see the Preflight base setup.
- [ ] `--method merge` (the default) is the one that leaves the branch tip an
      ancestor of the base, which the ancestry fallback depends on. If you test
      `squash` or `rebase`, expect the ancestry probe not to catch it.
- [ ] `pr-merge` on an already-merged repo reports `alreadyMerged` without a
      second `gh` call.
- [ ] `vcs pr-status` resolves each repo's state against its **own** branch,
      base and PR. A project the run never committed to never reads merged.
- [ ] Each merged repo's **clean** tree is removed independently, in its own
      repo root; a dirty tree is kept; the run dir outlives them.
- [ ] Only once **every** declared repo is merged does the glyph read merged.

If the session must stop before merging, record A11 as `not reached` and close
the PRs instead. Never merge into `main` to tick a box.

### A12 · Mobile Snapshot

- [ ] The phone snapshot's `vcs` carries a `repos` list **additively**, beside
      the flat fields that still describe the primary.
- [ ] Protocol stays **v2**; relay scopes are untouched (scopes freeze at pair
      time — a new one breaks paired phones).
- [ ] A paired phone that ignores the list renders the two-project run without
      error.

## Scenario B — Single-Repo Control

The regression check that protects everyone not using this feature. A default
run must be **unchanged**, not merely working.

`tests/sprintengine_tool/test_single_repo_control.py` pins this at the unit
level. This scenario is the live-app half — do not treat either as covering the
other.

- [ ] Create a normal single-repo worktree run on `multicode` (no projects
      selected).
- [ ] Worktree path is `.multi-code/sprintengine/<team>/worktree` — no `-<id>`
      suffix. Branch name unchanged.
- [ ] Commit shapes and evidence paths are unchanged.
- [ ] Every task defaults to repo `primary`; nothing requires naming a repo.
- [ ] The PR body is **byte-identical** to a pre-MC-1612 body — pass two is
      skipped, so there is **no companion section**.
- [ ] Exactly **one** accent "View pull request" chip; the glyph label is the
      bare one, with no project count.
- [ ] The Backlog PR link is the bare id, with an unqualified label.
- [ ] The mobile snapshot has **no** `repos` key (a one-entry list would only
      repeat the primary block).
- [ ] The wizard shows the project picker only in worktree mode.

Any difference here is a **blocking** finding, however cosmetic it looks.

## Cleanup

The session leaves real state behind. Clean it up in the same sitting:

- [ ] Close any pull request A11 did not merge — `gh pr close`.
- [ ] Delete the `sprintengine/<team>` branches from both remotes.
- [ ] Delete the `e2e/multi-repo-base` branches, local and remote, from both
      repos. They exist only to absorb this session's merges.
- [ ] Remove the run's worktrees from **both** repo roots
      (`git worktree remove`), then `git worktree prune`. A11 already removed
      the merged, clean ones.
- [ ] Delete the run dir under `.multi-code/sprintengine/`.
- [ ] Confirm both repos are back on their default branches with clean trees,
      and that **no** validation commit reached either `main`.

## Recording Results

- [ ] Record each step as `pass`, `fail`, `unverified`, or `not reached` —
      those four, honestly. Partial evidence is the expected outcome of a
      supervised session; a clean sweep of unearned passes is worse than gaps.
- [ ] Name the app version/commit, the date, and both repos' HEADs.
- [ ] Keep evidence next to this file (`validation/cross-repo-sprint-e2e/`),
      not in a run store — run stores are ignored local runtime state
      (`docs/sprintengine-runtime-state-policy.md`).

## Discrepancies

**File every discrepancy as a Backlog item before the epic closes.** A finding
recorded only in this file, a terminal, or a run's evidence log is lost the
moment the session ends.

- One item per discrepancy, `type: bug`, with reproduction steps and the step
  above that surfaced it.
- Link them to the `multi-repo-sprints` epic (`epic: multi-repo-sprints`).
- MC-1614 and the epic close **only** when this checklist has been executed and
  every discrepancy is filed. Filed — not necessarily fixed; triage decides
  which block the epic and which ship as known issues.
- If the session cannot be completed at all, that is itself an item, and the
  epic does not close.
