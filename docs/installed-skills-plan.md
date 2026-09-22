# Installed skills in Search Everywhere

Implementation plan, 2026-09-21.

1. Read installed skills from the focused CLI's project and user directories.
   Keep installation identity (path and scope) separate from the skill name;
   two copies with the same name must remain inspectable. Include shared skill
   directories where the CLI supports them. Report unreadable locations.
2. Turn the Skills tab into an immediate, uncapped inventory grouped by Project
   and Global. Show the selected CLI, allow changing it, and filter locally as
   the user types. Keep catalogue discovery reachable through Browse skills.
3. Selecting a skill opens its actions and installation details. Use inserts an
   invocation into a matching live agent without reinstalling the skill. Remove
   names the scope and exact location, then moves only that installation to
   Trash. A linked installation removes the link, never its target. Managed
   skills explain why they cannot be removed individually.
4. Test discovery, duplicate names, CLI filtering, missing and unreadable paths,
   targeted removal, symlinks, stale requests, and the keyboard/UI flow. Run the
   repository gates and review the final diff for regressions and shared-branch
   changes before handing it back. No PR or branch change is part of this work.

Installed means present on disk in a discovered location. It does not assert
that an already-running CLI has reloaded that skill. The surface states this
distinction and offers refresh.

## Implemented

The inventory reads each CLI's project and user locations, shared compatibility
folders, repository ancestors up to the checkout boundary, and managed system
or plugin locations. Codex's configured plugin caches and Claude's plugin
installation receipts are read separately from marketplace catalogue listings.
Grok's configured skill paths and local plugin folders are also included.
Custom launch flags and remote/account-synced skills are outside this local
filesystem inventory; presence on disk is not a claim that a running session
loaded a skill. Discovery conventions were checked against the official
[Codex](https://learn.chatgpt.com/docs/build-skills),
[Claude Code](https://code.claude.com/docs/en/skills), and
[Grok](https://docs.x.ai/build/features/skills-plugins-marketplaces) documentation.

Each row keeps its physical path. Managed plugin/system skills are inspectable
but cannot be removed individually. Ordinary removal uses Trash and validates
the installation again before mutation. Changed entries, fabricated identities,
and directories reached through a shared parent link are refused.

## Revised 2026-09-22

The CLI select and the panel's own filter field are gone. The Skills tab keeps
the palette's single field, which filters the inventory, and the CLI is decided
rather than chosen: the targeted or focused agent, then the most recent agent
whose CLI reads skills, then the only such CLI installed. A quiet meta line
names it beside Refresh and Browse skills. Each scope shows ten rows and a
keyboard-reachable Show more row that reveals ten more of that scope.

Discovery now compares paths as paths (Windows case and separators), reads
`CLAUDE_CONFIG_DIR` by its first comma entry, accepts the older single-object
Claude plugin receipt, matches project receipts against checkout ancestors,
and, for a CLI that runs inside WSL, reads the user folders from the WSL home
(found through `wsl.exe` and `wslpath -w`) instead of the Windows profile.

## Review and verification

- Focused discovery, removal, UI, search, and config-reader tests: 19 passed.
- Full suite at the final verification pass: 599 files passed, 726 tests passed,
  one skipped. The subsequent focus/cancellation changes passed focused tests.
- App and test typechecks, project lint, formatting, unused-dependency checks,
  design-system lint, SDK/package checks, seed checks, and release tests passed
  individually, except the SDK drift gate described below.
- The real React inventory was rendered with the app stylesheet in the Studio
  browser using fixture installations. The grouped list and filtering were
  checked visually. Main-process discovery was also exercised read-only against
  the local Codex, Claude Code, and Grok inventories, without removing skills.
- Review fixed focus restoration from details, returning to All with Backspace,
  restoration to the palette opener, and cancellation of a pending invocation
  after the panel unmounts.

The shared checkout's full verification stopped on SDK drift between the app
and package `GlobalSurfaceShell` props. A production build compiled but failed
the eager-bundle guard on Monaco references. Those are outside this change;
the affected files were left to the agents editing them. No branch switch,
commit, or pull request was made by this task.
