# Pooled agent worktrees — parked design

Status: **parked** (owner ruling 2026-09-24). Nothing here is built. A first
implementation merged as #52 and was reverted by #54; its code stays reachable
at commit `301b64159` for reference. This file records what was decided, what
the first implementation got wrong, and what still needs a ruling before the
work restarts.

## 1. The problem

Every agent that works in its own git worktree today gets a fresh one:
`git worktree add`, then — because a new worktree has no installed
dependencies — the agent pays for `npm install` (or the language's equivalent)
before its tests pass. On a warm macOS cache that is a few seconds; on Windows,
with a cold cache, or with native rebuilds it is much longer, and each worktree
holds its own copy of the dependencies on disk.

A pool keeps finished worktrees (with their dependencies) instead of deleting
them, and hands one to the next agent after resetting it to a clean base.

## 2. Why the first implementation was reverted

- **It worked while nobody asked for it.** Warm slots were refreshed every 30
  minutes and dependencies reinstalled in the background, costing CPU, disk and
  battery on machines where the pool might never be used.
- **It silently changed the base branch.** New chat and "+ Worktree" started
  handing out `origin/<default>` instead of the checkout's current branch, so a
  person working on a feature branch got an agent on main without asking.
- **Hand-out could be stale.** A lease did not fetch first, so a slot could be
  up to 30 minutes behind origin.
- **Installs only understood JavaScript lockfiles.**
- **Agents that create worktrees themselves bypassed it entirely.**

What it got right, and should be kept: the reset that preserves ignored files
(`read-tree --reset -u <sha>` then `clean -fd`, never `-x`), detached idle
slots, `git worktree lock` while leased, holding (never resetting) a dirty
return, lease ids in worktree identity, crash-safe per-step state, removal of
files the app wrote per agent (`.mcp.json` and similar) before reuse, and one
pool per repository and machine so Windows and WSL never share slots.

## 3. Decisions taken

| Decision                | Ruling                                                                                                                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle cost               | None. The pool is finished worktrees kept on disk; no timers, no background refresh, no idle installs. The only idle cost is disk.                                                                                                                    |
| When a slot is prepared | On intent: when the person ticks "worktree" in New chat or starts naming one, fetch once and reset a free slot to the chosen base in the background, so it is ready by the time they press Enter.                                                     |
| Base                    | `origin/<default branch>` by default, with a base-branch picker in New chat. A feature-branch base still reuses a pooled slot and switches it to that base.                                                                                           |
| Installs                | After hand-out, and only when the lockfile fingerprint changed since the slot last installed. No approval step. Covers npm, pnpm, yarn, bun, Cargo, Go, uv, Poetry, Bundler, Composer and Gradle/Maven, plus a per-repository setup command override. |
| Pool size               | Keep 1–3 finished worktrees per repository; anything beyond that is removed by the automatic agent-worktree cleanup (#57's rules).                                                                                                                    |
| Slot paths              | Stable and reused (`.sprintengine-worktrees/<repo>/pool-NN`). Accepted trade-off: a CLI's own per-directory resume history mixes across leases; the app always resumes by session id.                                                                 |
| Agent branches          | Kept on return (the slot is detached, the branch stays).                                                                                                                                                                                              |
| Dirty returns           | Held, locked and never reset; the Worktree manager offers Commit, Stash, Discard and Keep.                                                                                                                                                            |
| WSL                     | A pool per machine; WSL pools run through the distribution's git via the Linux helper.                                                                                                                                                                |
| Review                  | Before it ships, the design is checked against the bug history of existing open-source worktree-pool tools, and every class of bug they hit is shown handled or fixed.                                                                                |

## 4. Open questions

1. **Agents that create worktrees themselves.** Offer an MCP tool ("get me a
   worktree") and tell agents to use it through the Studio skill, or install a
   `git` shim on the agent's `PATH` that routes `git worktree add` to the pool?
   The tool is simpler and less surprising; the shim covers everything.
2. **Prepare-on-intent triggers.** Is ticking "worktree" enough, or should
   typing the prompt first and ticking afterwards also count? What happens when
   the person abandons New chat — keep the prepared slot warm or leave it?
3. **Default base.** `origin/<default>` (decided above) or the checkout's
   current branch, which is what New chat did before the pool?
4. **Where install progress shows.** In the agent's terminal before the CLI
   starts, as a banner, or silently in the background with a failure notice?
5. **Untrusted repositories.** Automatic installs run a repository's install
   scripts without asking. Acceptable for all repositories, or only ones the
   person has marked trusted?
6. **Adopting existing worktrees.** Should agent worktrees made outside the
   pool (or by an agent) be adopted into it when they are finished, instead of
   removed?
7. **Merged agent branches.** Keep them indefinitely, or delete them once
   merged into the default branch?
8. **Automation runs.** Keep creating and removing their own worktrees, or
   lease from the pool?
9. **Disk cap and eviction.** Defaults (the first implementation used 20 GB and
   7 days idle) and whether the person sees them in Settings.
