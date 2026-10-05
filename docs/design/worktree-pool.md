# Pooled agent worktrees

Status: **built** (owner ruling 2026-10-05), in `src/main/worktree-pool/`. A
first implementation merged as #52 and was reverted by #54; its code stays
reachable at commit `301b64159`. Section 5 says how this one differs; sections
2–4 are the history it was built from.

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
| When a slot is prepared | On intent: when the person turns on the Worktree chip in New chat or starts typing its name, fetch once and reset a free slot to the chosen base in the background, so it is ready by the time they press Enter.                                      |
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
2. **Prepare-on-intent triggers.** Is turning the Worktree chip on enough, or
   should typing the prompt first and turning it on afterwards also count? What
   happens when the person abandons New chat — keep the prepared slot warm or
   leave it?
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
8. **Scheduled agents.** Each run of a scheduled agent is a new chat, started
   with no window open and with the worktree setting the agent was made with.
   Should those runs keep creating and removing their own worktrees, or lease
   from the pool?
9. **Disk cap and eviction.** Defaults (the first implementation used 20 GB and
   7 days idle) and whether the person sees them in Settings.

## 5. What was built (2026-10-05)

The owner's rulings on restarting the work, and how the open questions above
were settled:

- **No installs, ever.** The pool never runs a package manager, in the
  background or after hand-out. A reused slot keeps the last agent's ignored
  files (`node_modules`, build output, a virtual environment), so the next
  agent's own install is incremental or unnecessary. This replaces the
  "install when the lockfile changed" decision in section 3, and with it
  questions 4 and 5.
- **Always the default branch.** Every agent worktree forks from
  `origin/<default>`, fetched at hand-out (at most once a minute per
  repository, and never waiting more than ten seconds; offline it forks from
  what the ref already says). That settles question 3. There is no base-branch
  picker yet; `agent.launch` with an explicit `worktree.baseRef` still forks
  that ref, outside the pool.
- **No idle cost.** No timers refresh or warm anything. A slot is reset to the
  base when it is leased, not when it is returned. The only timer is the
  instance lock's heartbeat, which touches one file.
- **One way in.** `createGitWorktree({ fromPool: true })` leases a slot when
  the process keeps a pool (the desktop's main), and otherwise creates a fresh
  worktree from the same base (the out-of-process server, a WSL machine, the
  pool turned off). New chat, the tab strip's worktree spawn, `agent.launch`
  and scheduled runs all go through it. That settles question 8.
- **Agents that want a worktree** call `worktree.lease` (and optionally
  `worktree.release`) instead of `git worktree add` (question 1: the tool, not
  a shim). The lease is the calling agent's and is kept while that agent
  exists.
- **Returns ride the agent worktree cleanup.** The sweep that already knows
  every path the app's records use hands each unused slot back to the pool
  instead of removing it; the pool detaches it (branch kept), clears the
  per-agent files and unlocks it. A lease never seen in use is left alone for
  an hour. Dirty returns are held, and the Worktree manager offers Commit,
  Stash, Discard and Keep on them.
- **Merged agent branches are deleted** by the same sweep once no worktree has
  them checked out, no chat or worktree entry records them, and their work is
  on the default branch, squash merges included (question 7). A branch a chat
  still records is kept: a settled chat is restored from it.
- **Settled chats.** A settled chat in a pool slot offers it to the sweep like
  any settled worktree chat; the slot goes back to the pool and the chat is
  marked reclaimed. Opening the chat again asks the pool for that same slot
  (`reclaim`), which checks the chat's branch out in it again, ignored files
  and all. Leases take the least recently used idle slot, so a just-settled
  chat's slot is the last to go to someone else; if it has gone, the chat is
  told why.
- **Pool size.** Up to three idle slots per repository are kept (setting
  `keepIdle`); a return beyond that removes the least recently used. Leased
  slots are not capped below 32.

Still open: adopting worktrees made outside the pool (question 6), a disk cap
(question 9), and a settled chat whose slot was given to another agent: today
it is told so and opens without its folder, where it could take a slot of its
own on its branch instead.
