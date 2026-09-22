# SprintEngine Studio Release Checklist

Every push to main starts a stable desktop release. PRs merge by merge commit or
squash, never rebase, with Conventional Commit titles; see
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Before merging

- Pass the required PR-title, build and JS checks. The release also runs
  `npm run verify:app` and the marketplace signature check against the exact
  source commit before it publishes.
- Select the intended version bump: `feat` means minor, `!` or a
  `BREAKING CHANGE:` footer means major (even from 0.x), and every other
  accepted type means patch. Maintenance-only merges also release the app.
- Describe user-visible changes and compatibility breaks in the PR body. The
  merge or squash commit keeps both the title and body.
- Do not manually edit the app version. Stable tags are the release version
  ledger; the workflow stamps `package.json` before compilation and packaging.
  The committed version remains a development baseline. SDK versions are separate.
- Keep the download site's release-notes data in step with releases if using its
  version-specific What's New section.
- Keep macOS signing credentials configured: the `CSC_*` pair and `APPLE_*`
  trio. Windows uses all seven `AZURE_*` Trusted Signing secrets, or none for
  unsigned installers; a partial set fails packaging.

## Retirements To State In Release Notes

Removals an installed profile cannot be migrated through. State each in the notes
of the first release that ships it, then delete the line.

- Automation review-only mode (item 2032): `autonomyDefault: 'review_only' |
  'allow_changes'` is retired. An existing automation on disk still loads — the
  key is dropped on read and never written back — and one whose author chose
  `review_only` keeps that intent: it is carried into the composed prompt as a
  write-up-only instruction, so nothing silently becomes a fixer. Two behaviour
  changes ride with it. The `withheldChanges` pull-request safeguard, which
  refused to stage or push an unexpected working diff, is gone with the field;
  every automation run may now backstop-commit its diff, contained by its own
  worktree, its own branch, and a pull request nothing merges automatically.
  And an automation with no explicit permission preset now launches its agent on
  `bypass_all` (item 2033) rather than stopping for an approval nobody is awake
  to give. An agent still cannot grant itself bypass through the MCP tools.
- Automation autonomy field on the module SDK (item 2032): `autonomyDefault` is
  removed from `AutomationDefinition`, `AutomationDefinitionDraft` and the patch
  type in `@sprintengine/module-sdk`. This is a **breaking type change** for a
  module that sets the field — the property no longer exists, so the compile
  fails rather than the value being ignored. Delete the assignment; there is no
  replacement, and reviewer-versus-fixer intent belongs in the prompt.
- Attention Queue shortcut: the cross-workspace Attention Queue popover in the
  window's top-right corner was removed - the sidebar rows and the Home glyph's
  notifications already say which agents are waiting on you - and the
  `panel.attention-queue.toggle` command went with it. The command shipped
  unbound, so only a user who bound it by hand is affected: that shortcut stopped
  firing when the popover was removed, and opening Settings -> Shortcuts now
  drops the saved binding. There is no replacement shortcut.
- The Sprint Engine, 2026-09-16: the agent-looping run engine is removed from
  the application. The Sprints door, the run board and its inspector, the New
  sprint dialog, the run-backed workspace mode, the `sprint.*` MCP tools, the
  `panel.sprint-engines.toggle` shortcut and the board and New sprint shortcuts
  (`sprint-engine.*`, and the older `sprintengine.*` spellings) all go with it;
  a custom shortcut saved for any of those commands is dropped when Settings ->
  Shortcuts is opened. A board or Architect Plan tab dragged into another
  workspace is removed from its layout.
  A workspace saved in the run-backed mode is DROPPED from the Projects list -
  everything a run wrote is on disk and untouched under the workspace's
  `.sprintengine/` sidecar, so open the project as a normal chat to keep working
  on those files. A Backlog item's `sprints:` frontmatter field is no longer read
  or written; `pr:` is unchanged, and its links now resolve through the Backlog
  itself rather than through the engine. The engine returns as an installable
  capability module under the reserved id `sprint-engine`, published separately -
  the id stays claimed in this build so nothing else can take the name.
- Workflow roles, 2026-09-16: the app no longer has a concept of a role. The
  role registry, the role picker and the role brief are gone,
  and the `workflow-roles` plugin is no longer offered in the bundled
  marketplace seed. The sixteen role skills are unaffected as SKILLS - they ship
  from `sprintengine/studio-releases` and install like any other plugin. Invoke
  one from a terminal (`/architect`) instead of picking a role in the app.
- Design Wizard (the guided brief), 2026-09-08: the workspace that interviewed
  you about product, architecture and frontend and minted a `guided-brief`
  workspace is removed outright. There is no replacement flow.
  A workspace saved in that mode is DROPPED from the Projects list on first load
  - everything it wrote is on disk and untouched (`product/`, `architecture/`,
  `mockups/`, `design-system/`, `.guided-brief/`), so open the project as a normal
  chat to keep working on those files. The Settings -> Agents toggle that ran the
  design interview as chat sessions is gone and its saved value is dropped. The
  Design door, design-system bundles, the library, attach and the bundle lint are
  unaffected - they were never part of the wizard. Three Learn Center cards under
  a "Design Wizard" category are gone with it.

- Horizon and Multiloop, 2026-09-08: the two workspace modes are removed from
  the tree. A workspace saved in either mode is DROPPED from the Projects list
  on first load (`dropRetiredModeWorkspaces`, which runs on every list-entry
  path, not only in the migration rung) — everything either wrote is on disk and
  untouched, so open the project as a normal chat to keep working on those
  files. Horizon's functional leftovers go with it: two tailnet scopes no tool
  could require, a chip variant only its step rows used, and the backlog header
  action only its own start entry supplied.

- Third-party skills and MCP servers, 2026-09-08: the studio no longer
  ships anybody else's software. The bundled MCP catalogue
  (`resources/mcps/catalog.json`, sixteen servers) is deleted with its reader,
  and with it the whole `catalog` population of the Extensions door: the browse
  grid now lists the marketplace registry's plugins only, the New chat composer
  and the automation connector picker offer the MCP servers you have installed
  and no others, and the Connectors detail pane for a catalogue server is gone.
  **Nothing installed is removed or disabled** — a server already in your MCP
  settings keeps working, keeps launching and keeps syncing. What goes is the
  route to servers you had NOT installed: the sixteen are no longer offered, and
  none of them has a replacement in any plugin marketplace we recommend, so a
  card or a flow that named one now says so instead of installing it. Settings →
  Ticket trackers lists nothing of its own for the same reason and points at the
  plugin catalogue, where Jira, Linear, GitHub and GitLab live. The four signed
  first-party MCP bundles leave the marketplace index in the same change: it is
  18 rows now (13 agent CLIs, 5 automation starters) and carries no signed
  component at all.
- Plugin-source update cadence, 2026-09-08: without a GitHub token the
  studio checks each plugin source for updates **once a day** rather than once an
  hour, because anonymous GitHub allows 60 requests an hour for the whole
  machine. With a token configured the hourly cadence is unchanged. The cadence
  in force is stated beside the token field in Settings → GitHub, and a new
  "Check for updates" action on a source's overflow counts against the same
  window and says when the source was last asked.

## Main builds and publishing

`.github/workflows/release.yml` builds macOS Intel and Apple Silicon DMGs and
updater ZIPs, a Windows installer, and a Linux AppImage. All four jobs use
`--publish never`. One publisher waits for packaging and quality checks, merges
both Mac updater manifests, uploads every file to a draft, then publishes it
as the latest stable release on `sprintengine/studio`. It verifies installers,
manifests and the anonymous URLs installed apps use to discover updates.

The resolver reads the push's exact SHA, full first-parent history and stable
tags. The strongest Conventional Commit since the preceding stable tag selects
one bump. With one merge or squash per push, every successful merge releases
once; the resolver walks first-parent history, so the branch commits under a
merge commit are never read.
A failed build leaves its changes for the next successful release. During the
initial migration only, older prose subjects count as patch changes; the new
release tip must be conventional. Branch-internal experiment commits do not
influence a squash or merge commit's release type.

All release entry points share one concurrency group with `queue: max` and
cancellation disabled. GitHub queues up to 100 pending runs, ordered by when
they enter the queue; dispatch order is not guaranteed. An older run already
covered by a newer published stable is skipped, so it cannot roll the latest
pointer back. Monitor queue capacity if merges outpace packaging.

A tag left by an interrupted draft reserves its version. Retrying that commit
uses the same version; a later commit uses a new version. Published commits are
skipped on retry. No version-bump commit is pushed to main and the workflow's
own token does not trigger a second release from the tag it creates.

The release body records `<!-- source-sha: -->` for traceability and preview
promotion; do not remove it. Public-source release notes list changes since
the preceding release on that channel. Private-source subjects are omitted.

## Optional manual releases

- Push a tag shaped `vX.Y.Z` matching the committed package version to build
  that exact version. This is a manual escape hatch, not the main release path.
- Dispatch channel `preview` to build a preview from the selected workflow ref
  (select main). Previews use `X.Y.Z-preview.YYYYMMDD.RUN`, with the next patch
  after the latest stable unless the committed version is higher.
- The optional six-hour preview schedule runs only with repository variable
  `PREVIEW_SCHEDULE=enabled`, and skips when main has not moved.
- Dispatch channel `stable` to promote the latest preview's exact source SHA.
  Promotion is rejected if its core version is already released. Main releases
  do not require a prior preview.
- Set dispatch `publish=false` to retain packages as workflow artifacts for
  14 days without publishing a release.

## GitHub enforcement

The versioned ruleset is [main-ruleset.json](../.github/main-ruleset.json).
It requires a PR, a merge commit or a squash (no rebase), resolved
conversations and these checks from GitHub Actions: **Conventional PR title**, **Build
(ubuntu-latest)**, **Build (windows-latest)**, **Build (macos-latest)** and
**JS tests (ubuntu-latest)**. It prohibits force pushes and branch deletion,
requires checks against current main, and has no bypass actors. No additional
human approval count is imposed.

Repository settings must also set `allow_squash_merge=true`,
`allow_merge_commit=true`, `allow_rebase_merge=false`,
`squash_merge_commit_title=PR_TITLE`, `squash_merge_commit_message=PR_BODY`,
`merge_commit_title=PR_TITLE` and `merge_commit_message=PR_BODY`, so a merge
commit carries the same conventional message a squash does. Dependabot is configured to use
`build:` and `ci:` titles so its updates pass the same check.

For a new repository, create the PR containing the title-check workflow before
activating this ruleset, so that its required check can run. Apply the JSON with
`gh api --method POST repos/OWNER/REPO/rulesets --input .github/main-ruleset.json`;
update an existing rule with PUT at its ruleset ID. Do not create duplicate rules.
The JSON is a reproducible policy definition; editing it alone does not change
GitHub settings.

## Smoke Test

- Install on a clean Windows machine or VM.
- Install on macOS Intel and Apple Silicon where available.
- Install on Linux using the AppImage.
- Launch the installed app.
- Confirm Help -> Check For Updates opens Settings and performs a visible update check.
- Confirm Settings shows version, channel, packaged state, and update status.
- Confirm terminal sessions launch.
- Confirm Git panel reads status in a real repository.
- Confirm the Backlog door lists items in a project that has a `backlog/`.
- Confirm protocol registration for `sprintengine://` auth callbacks still works.

## Update Validation

- Install the previous release.
- Publish or draft the next release.
- Start the previous release and run Help -> Check For Updates.
- Confirm the new version is detected.
- Confirm download progress is visible.
- Confirm Restart installs the update.
- Relaunch and verify the new version is shown in Settings.

## Failure And Rollback

- Confirm manual update check errors are visible in Settings.
- Confirm updater errors are written to diagnostics logs.
- Keep the previous installer available in GitHub Releases.
- For a bad release, mark the GitHub Release as not latest or remove the updater metadata asset after deciding on the rollback path.
- Publish a patch release as the preferred rollback mechanism when users may already have installed the bad build.
