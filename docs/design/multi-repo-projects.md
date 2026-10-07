# One project, several repositories

Status: proposed, 2026-10-07. Section 6 (the first slice) is built on
`feat/multi-repo-projects`; everything in section 7 is not. The questions in
section 8 are the owner's. When code and this file disagree, fix one of them in
the same change.

## 1. The problem

Many people keep a parent folder that is not itself a repository and holds
several that are:

```
acme/
  api/      ← a repository
  web/      ← a repository
  infra/    ← a repository
  acme.code-workspace   (sometimes)
```

The work they ask an agent for crosses them: "add the field to the API and show
it on the page" is a change in `api` and a change in `web`. Today Studio treats
`acme/` as a plain folder. A chat can be started there and its agent can edit
both repositories, but nothing else in the app follows it:

| Surface                       | What happens in `acme/` today                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace                     | One `folderPath` (`src/renderer/src/types/workspace.ts`) and an optional `worktree`/`repoRoot`. Nothing says the folder holds repositories.                                                                                    |
| Agent                         | Told nothing. It runs `git status` in `acme/`, gets "not a git repository", and works it out, or does not.                                                                                                                     |
| Git panel                     | Follows one root, `useGitStatus(folderPath)` (`GitPanel.tsx`), and shows "This folder is not a Git repository."                                                                                                                |
| Changed files card and Revert | Built from per-turn checkpoints (`conversation-checkpoints.ts`), which need the chat's folder to be inside a work tree. In `acme/` there are none, so no card and no Revert.                                                   |
| Terminal agents' changelists  | `agent-changelist-feed.ts` keys an edit by the session's checkout. A session in `acme/` has none, so every edit is dropped.                                                                                                    |
| Sidebar counts                | `workspace-change-summary.ts` and `git-branch-span.ts` read one checkout. None here, so no numbers.                                                                                                                            |
| Worktree                      | The New chat composer offers the Worktree chip only inside a repository, so it is absent; a phone's or an agent's `newWorktree` is refused as "not a git repository".                                                          |
| Pull requests                 | A pull request the agent opens in `api` is already recorded against the chat (`packages/studio-protocol/src/pull-requests.ts` lists other repositories' too). The chat's Create PR is not offered: the chat is in no checkout. |
| Project identity              | `acme/` has no remote, so its project key is the folder identity and its hue hashes the name "acme" (`projectColor.ts`, `repository-identity.ts`). A chat opened on `acme/api` directly is a different project, "api".         |

## 2. Words

- **Project folder**: the folder a workspace is opened on (`folderPath`).
- **Multi-repository project**: a project folder that is not inside a
  repository and holds at least one, found by the rules in section 3.
- **Member repository**: one of those repositories, by its absolute path and
  its path relative to the project folder (`api`, `services/billing`).

A project folder that is itself a repository, or inside one, is never a
multi-repository project, whatever it holds below it: the repository it is in
is the project, as today, and submodules and nested clones are that
repository's business.

## 3. Discovery

`src/main/project-repositories.ts`, pure apart from `fs`, and tested on real
temporary folders.

### 3.1 Rules

1. **The folder must not be in a repository.** The folder and each of its
   ancestors is checked for a `.git` entry (a directory, or the file a linked
   worktree or submodule has). One `lstat` per level, no git process. Any hit
   and the answer is "not a multi-repository project". This is the same walk
   git makes to find its work tree; it ignores `GIT_DIR` and
   `GIT_CEILING_DIRECTORIES`, which the app does not set for these reads.
2. **A single `.code-workspace` file wins.** When exactly one `*.code-workspace`
   file sits directly in the project folder and parses, its `folders[].path`
   entries are the candidates, in the file's order. The file is JSON with
   comments and trailing commas, which the reader tolerates. Two or more such
   files are ambiguous and are ignored, as is one that does not parse or lists
   no repository (a single-folder `{ "path": "." }` file is the common case);
   each falls back to rule 3.
3. **Otherwise, immediate children.** Every direct child directory with a `.git`
   entry, sorted by name. Never recursive.
4. **Never outside the project folder.** A workspace entry that is absolute
   and elsewhere, that climbs out with `..`, or whose real path (symlinks
   followed) leaves the project folder is rejected. A child that is a symlink
   is not followed at all. The project folder itself (`"path": "."`) is not a
   member: it is not a repository by rule 1.
5. **Depth limit.** A workspace entry may be at most three folders below the
   project folder (`services/billing/api`). Children are one level by
   definition.
6. **Members are repository roots.** A candidate counts only when it has its
   own `.git` entry. `api/src` listed in a workspace file is a folder of a
   repository, not a repository, and is skipped.
7. **Nested repositories and submodules are ignored.** A candidate inside
   another member (`api` and `api/vendor/lib`) is dropped; the outer member
   owns it. Children are never descended into, so a submodule below one is
   never seen.
8. **Hidden and tool folders are skipped**: any child whose name starts with a
   dot (which covers `.sprintengine-worktrees`, where the pool keeps every
   member's worktrees, and `.git` itself) and `node_modules`.
9. **Cap of twenty.** At most twenty members are listed. A folder with more is
   still reported, with `truncated: true` and the first twenty; section 5 says
   what a truncated project gives up.
10. **Never the home folder or a filesystem root.** Both hold clones nobody
    means as one project, and a chat opened there would checkpoint every one
    of them.

The answer is the project folder, where the list came from (`children` or the
workspace file's name), the members (absolute path, relative path, display
name), and `truncated`.

### 3.2 Refresh

The answer is cached per folder for thirty seconds and keyed by the folder's
own modification time, so a member cloned into or removed from the folder is
seen on the next read. A `.git` appearing inside an existing child (`git init`
there) does not touch the parent's time, so it waits for the thirty seconds or
for a read that asks for a fresh answer (`refresh: true`; the Git panel's
refresh does). No watcher is installed for discovery: a project changes shape
about never, and a watcher per project folder is a cost every open window would
pay all day for it.

## 4. What each surface does

### 4.1 Agent instructions

Every agent started in a multi-repository project is told, in the standing
instructions Studio already passes, that the folder is not a repository, which
repositories it holds, and to run git inside each (`git -C api status`). One
pure builder, `projectRepositoriesInstructions` in
`src/shared/project-repositories.ts`, so every channel says the same words:

| Agent                                | Channel                                                                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal agents, every CLI           | A `## Repositories` section of the host-context document (`src/shared/host-context/document.ts`), delivered by the CLI manifest's `contextInjection` like the design-system line. |
| Claude Code chats                    | Appended to the system prompt after the project's `CLAUDE.md` (`claude-agent-provider.ts`).                                                                                       |
| Codex chats                          | `developerInstructions` on `thread/start` and `thread/resume`, set only for a multi-repository project, so every other launch is unchanged.                                       |
| ACP chats (Gemini, OpenCode, others) | Nothing in the first slice: ACP has no standing-instruction channel, and the alternative, pasting into the person's message, is what the host-context design removed.             |

A chat on a WSL machine is not told in the first slice: the member paths would
be this computer's names for that machine's folders.

### 4.2 Git panel

When the workspace folder is a multi-repository project, the panel grows a
**Repository** row above Branch, in the same label-and-select grid, listing the
members. Everything below it is today's panel opened on the chosen member: the
panel body is remounted per member (`key` on its path), so its scopes,
branches, graph, stashes and watcher are the member's, through the same code
paths a single-repository workspace uses. Commit drafts are kept per member and
scope. The choice is remembered for the window's lifetime, per workspace; it is
not written to the workspace record, which rides workspace sync.

Only the chosen member is watched, so the panel's cost does not grow with the
number of members.

### 4.3 Checkpoints and Revert — captured per member

**Decision: capture each member.** The checkpoint machinery is already per
repository, and its refs are keyed by the conversation (workspace and agent),
not by the folder, so running it once per member is a loop around the calls
that exist: `ProjectCheckpoints` (`src/main/project-checkpoints.ts`) wraps
`ConversationCheckpoints` and, for a multi-repository project, captures,
diffs, reverts, expires and deletes in each member. The alternative, leaving
checkpoints off, would leave a multi-repository chat with no changed-files card
and no Revert at all, which is most of what makes a chat's work reviewable.

- **Paths** in a turn's diff are project-relative: `api/src/user.ts`. A patch's
  headers are rewritten the same way.
- **A member that cannot be captured** (too many untracked files, git failed)
  is left out of that turn; the others still are. A member that appeared
  between a turn's `pre` and `post` has no `pre` and is left out of that turn's
  diff.
- **Revert** involves the members that hold the turn's checkpoint (for an
  undo, a recovery point), previews each of them first, and checks every
  member's list against what the dialog showed before it changes any file, so
  the drift check is the same per member as it is today. A member with nothing
  to restore is not touched. It is not atomic across members: a member
  that fails after another has been reverted stops the revert and says which
  member failed; each reverted member keeps its own recovery ref, so Undo
  restores those.
- **Cost**: each capture is the existing capture once per member, at most four
  at a time. A truncated project (more than twenty members) gets no checkpoints
  and so no card, rather than a turn that waits on twenty repositories.
- **A folder that is a repository** goes straight to `ConversationCheckpoints`,
  unchanged.

### 4.4 Changed files

The chat's changed-files card reads the turn diff, so with 4.3 it lists every
member's files. The tree's top level is the members (`api`, `web`), which is
the grouping by repository. Opening a file's diff resolves the member the file
is in and opens the app's diff viewer on that member, narrowed to that
member's files of the turn.

Terminal agents' per-agent changelists: when a session's own folder is in no
repository, the feed files each edit under the repository the edited file is
in, provided that is inside the session's folder. Each member then has the
agent's list in its Git panel, and the agent's exit marks all of them. The
Bash-edit adoption that activating the list at launch gives a single-repository
agent is not there, since at launch there is no one repository to activate it
in.

### 4.5 Worktrees and the pool

The worktree pool is per repository (`src/main/worktree-pool/`), and a
worktree of `acme/` would be a worktree of nothing. In the first slice:

- The New chat composer shows the Worktree chip disabled, with a tooltip saying
  worktrees for a project of several repositories are not available yet and
  that the chat runs in the project folder.
- `newWorktree` from a phone, a paired machine or an agent is refused in the
  same words, instead of "not a git repository".

The later design (question 8.1) is a worktree per member, leased together: a
folder `<pool>/acme-NN/` holding `api/` and `web/`, each a pool slot of its own
repository, linked or created so the agent sees the same layout as the project
folder. That needs a lease that can fail part way and return what it took, a
return that holds the set together when one member is dirty, and a cleanup
sweep that knows a set. None of it is trivially safe, so it waits.

### 4.6 Pull requests

Recording and linking are unchanged: an agent that opens a pull request in
`api` and another in `web` already has both recorded against its chat, from
the create command's output or `pull_request_link`. The chat's Create PR is not
offered in a multi-repository chat in the first slice (its readiness check
needs one checkout). Later: Create PR lists the members with commits ahead of
their base, and opens one pull request per member, each body naming the
others.

### 4.7 Sidebar grouping and project identity

Unchanged in the first slice. `acme/` has no remote, so its key is the folder
identity and its hue the hash of "acme"; its chats group under "acme". A chat
opened on `acme/api` stays its own project, "api". See question 8.2.

The sidebar's `+N −M` counts read one checkout (`workspace-change-summary.ts`)
and stay empty for a multi-repository chat. Later: the sum over members.

### 4.8 The phone and the tailnet

No wire changes. A multi-repository chat is an ordinary chat on the wire:
`workspace.list` projects it with no repository identity (as any folder with no
remote), and a phone or paired machine reading its turn diff gets the same
shape with project-relative paths. Revert is not offered on another machine
today and is not here either. The new IPC channel
(`git:get-project-repositories`) is desktop-only: it is not in the machine
channels an SSH machine's server answers, so a workspace on an SSH machine is
answered "not available" and the panel treats that as a single folder. Adding
it there later changes the private SSH backend wire and bumps
`BACKEND_WIRE_VERSION` (`docs/compatibility.md`).

## 5. Performance

- **No recursive scans.** Discovery reads one directory, `lstat`s one `.git`
  per child and per ancestor, and reads at most one small workspace file.
- **Bounded watchers.** Discovery has none. The Git panel watches the one
  member on screen.
- **Cap.** Twenty members. A truncated project lists twenty, says it holds
  more, and takes no checkpoints.
- **Checkpoints** run at most four members at a time.
- **Cache.** Thirty seconds per folder, invalidated by the folder's own
  modification time.

## 6. The first slice (built)

1. Discovery (`project-repositories.ts`), cached and tested: children,
   `.code-workspace`, entries outside the folder rejected, nested repositories
   ignored, the cap.
2. Chats in a multi-repository project run in the project folder (as any chat
   in a plain folder already does), and Claude Code chats, Codex chats and
   every terminal agent are told about the members.
3. Worktree: disabled in the composer with its reason; refused with the same
   reason by `conversation-launch-service.ts`.
4. Git panel: the Repository row, the body per member.
5. Changed files: the card lists every member's files under its member; the
   diff viewer opens on the right member; terminal agents' changelists land in
   each member.
6. Checkpoints and Revert per member.

## 7. Later steps

- Worktrees for multi-repository projects (question 8.1).
- Create PR per member (4.6).
- Sidebar `+N −M` summed over members (4.7).
- ACP chats told about the members, when ACP grows a channel for it, and WSL
  chats with the members' Linux paths.
- Members on an SSH machine (the machine channel and its wire bump, 4.8).
- The Repository row showing each member's change count, which costs one
  `git status` per member and so wants a watcher budget first.
- Settings ▸ Worktrees listing members' worktrees under the project.

## 8. Open questions for the owner

1. **Worktree mode for a multi-repository project.** A worktree per member,
   leased together into one folder that mirrors the project's layout (4.5)?
   Only for the members the person picks? Or never, and worktrees stay a
   single-repository feature? If leased together: does a set return to the pool
   whole, or does each member slot return on its own once clean?
2. **Project identity and colour.** Is `acme/` one project whose hue is the
   hash of "acme" (today), or is a chat in `acme/api` part of the `acme`
   project too, filed under it in the sidebar? Should the project key of a
   multi-repository project be built from its members' repository identities
   (so two machines' `acme/` with the same remotes are one project, as a
   single repository is), or stay the folder name?
3. **What wins, a workspace file or the children?** This design lets a single
   `.code-workspace` file decide the members outright. Should children that
   the file does not list be added too?
4. **The cap.** Twenty members, and no checkpoints past it. Is a folder of
   thirty repositories a project anyone works in, or a code directory that
   should not be treated as one at all?
5. **Revert across members.** Not atomic (4.3). Acceptable, or should a revert
   that fails part way put back the members it already reverted?
6. **A member's own chats.** When a chat is open on `acme/` and another on
   `acme/api`, their files overlap, but Revert's "stop the running turn first"
   guard sees two different folders. Should the guard treat a member as part of
   its project?
