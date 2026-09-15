# SprintEngine Studio Release Checklist

Use this checklist for every preview or stable desktop release.

## Before Tagging

- Confirm `npm run verify:app` passes. `release.yml`'s quality gate runs the
  whole of `ci.yml` (verify:app, the marketplace registry, pytest) against the
  release commit and the release will not publish without it, but it runs
  beside the packaging legs -- finding out locally is faster. `npm run
  typecheck:all` is worth running too; plain `typecheck` skips the test
  projects, which is how 99 test typecheck errors sat on `main` unnoticed before
  0.4.0. Delete any stale `tsconfig.*.tsbuildinfo` first, or an incremental
  build can report clean.
- Confirm `npm run build` passes, including the bundle-budget ratchet it
  chains. The ceiling only speaks during a build, so a breach can sit on
  `main` for weeks and first surface in the release's package job.
- Update `package.json` version.
- Run `npm run sync:model-feed`, and commit the result if it moved. This pulls
  the live `model-feed.json` from `studio-releases` into
  `resources/model-feed.json`, the seed a fresh install boots with. Do it
  BEFORE tagging, never in CI: a workflow that rewrites a committed file makes
  the shipped build differ from the tag it claims to be. A stale seed is not
  fatal (the live feed wins by `updatedAt` within the hour) but a fresh install
  shows an old list until its first fetch.
- Run `npm run sync:catalogue`, and commit the result if it moved. This pulls
  the published `workflow-roles` plugin from `studio-releases` into
  `resources/studio-plugin/workflow-roles/`, the offline seed the SprintEngine
  Studio tab lists when the network is away. It leaves `sprintengine-studio/`
  untouched — that plugin is authored here and published there, never pulled
  back. Same tagging rule as the model feed.
- Confirm `RELEASES_TOKEN` exists under Settings -> Secrets and variables ->
  Actions. Releases go to the PUBLIC `sprintengine/studio-releases`, and the
  workflow's own `GITHUB_TOKEN` cannot write to another repo. Without it the
  `validate` job now stops the release before anything is built.
- Draft release notes with user-visible changes, fixes, known issues, and rollback guidance.
- Update the download site's release-notes data to the version being released.
  The download page only renders What's New when its `version` equals the
  version it is serving, so notes left on the previous version do not go stale
  on screen -- they vanish from the page entirely.
- Confirm signing credentials are configured for any stable release: the
  `CSC_*` pair and `APPLE_*` trio for macOS, and for Windows either all seven
  `AZURE_*` Trusted Signing secrets or none (none ships unsigned; a partial set
  fails the Windows leg).

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
- Sprint Engines panel shortcut (item 1813): the Sprint Engines panel became the
  Sprints door, and the `panel.sprint-engines.toggle` command went with it. A
  custom shortcut saved for that command stopped firing when the panel was
  removed; opening Settings -> Shortcuts now drops the saved binding. There is no
  replacement shortcut - the Sprints door opens from the sidebar.
- Design Wizard (the guided brief), 2026-09-08: the workspace that put you in an
  interview with product, architect and frontend specialists and minted a
  `guided-brief` workspace is removed outright. There is no replacement flow.
  A workspace saved in that mode is DROPPED from the Projects list on first load
  - everything it wrote is on disk and untouched (`product/`, `architecture/`,
  `mockups/`, `design-system/`, `.guided-brief/`), so open the project as a normal
  chat to keep working on those files. The Settings -> Agents toggle "Design
  specialists as chat sessions" is gone and its saved value is dropped. The
  Design door, design-system bundles, the library, attach and the bundle lint are
  unaffected - they were never part of the wizard. Three Learn Center cards under
  a "Design Wizard" category are gone with it.

- Horizon and Multiloop, 2026-09-08: the two workspace modes are removed from
  the tree. A workspace saved in either mode is DROPPED from the Projects list
  on first load (`dropRetiredModeWorkspaces`, which runs on every list-entry
  path, not only in the migration rung) — everything either wrote is on disk and
  untouched, so open the project as a normal chat to keep working on those
  files. Horizon's functional leftovers go with it: two tailnet scopes no tool
  could require, a roster chip variant only its step rows used, and the backlog
  header action only its Start sprint supplied.

- Third-party skills and MCP servers, 2026-09-08 (MC-2519): the studio no longer
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
- Plugin-source update cadence, 2026-09-08 (MC-2519): without a GitHub token the
  studio checks each plugin source for updates **once a day** rather than once an
  hour, because anonymous GitHub allows 60 requests an hour for the whole
  machine. With a token configured the hourly cadence is unchanged. The cadence
  in force is stated beside the token field in Settings → GitHub, and a new
  "Check for updates" action on a source's overflow counts against the same
  window and says when the source was last asked.

## Tag And Build

`.github/workflows/release.yml` has three ways in. All of them package the four
legs with `--publish never`, run the full CI gate beside them, and publish from
one job: the two macOS updater manifests are merged, everything is uploaded to a
draft, and the release becomes visible only once every file is there.

- **Stable from a tag.** Create a tag matching `package.json`, for example
  `v0.4.0`, and push it. A prerelease tag must be shaped `vX.Y.Z-preview.N`:
  installed preview builds only follow tags whose prerelease starts with
  `preview`, so the workflow refuses any other (a `-beta.1` would reach nobody).
- **Preview.** Actions -> Release -> Run workflow, channel `preview`. It builds
  `main` as `X.Y.Z-preview.YYYYMMDD.RUN`, where `X.Y.Z` is `package.json`'s
  version while that is unreleased, else the next patch after the latest
  stable. The schedule does the same every six hours when `main` has moved, but
  only once the repository variable `PREVIEW_SCHEDULE` is `enabled`.
- **Stable by promotion.** Run workflow, channel `stable`. It rebuilds the exact
  commit the latest preview shipped, as that preview's `X.Y.Z`, and tags that
  commit `vX.Y.Z` in this repo. Stable then only ever ships a build preview
  users already ran. The commit is read from the `<!-- source-sha: -->` marker
  the workflow writes into every release body, so do not delete that line when
  editing a body.
- Set `publish` to false on a dispatch to build without releasing; the packages
  stay on the run as workflow artifacts for 14 days.
- Wait for the workflow. Its last step, `Verify the published release,
  authenticated and not`, checks the release is on the PUBLIC
  `sprintengine/studio-releases` (v0.3.0 shipped to the private repo and
  reported success because nothing checked), that it carries both macOS DMGs,
  the `.exe` and the `.AppImage`, and that each updater manifest (`latest*.yml`
  or `preview*.yml`) names this version, lists only files that are on the
  release, and -- for macOS -- lists a `.zip` for BOTH arches. Without the zip
  MacUpdater fails with `ERR_UPDATER_ZIP_FILE_NOT_FOUND`; with only one arch the
  other arch never updates.
- It then asks the same questions again with NO credential, at the three URLs
  electron-updater reads: `releases.atom` (which is where it finds a version at
  all), `releases/latest` (which is how a stable build resolves the newest one,
  and which must not resolve to a preview), and
  `releases/download/<tag>/<channel>*.yml`. The authenticated half passes
  against a repository no user can read, so it is this half that fails when the
  releases repo is private, is named wrong in `build.publish`, or has the
  release still in draft. The step polls for a short while first: the publish is
  seconds old and GitHub's cache can lag it.
- The release body is written by the workflow. While this repository is
  private it says only the version: commit subjects would leak private
  messages to the public releases repo. Once public it links the commit and
  lists the changes since the previous release on the same channel. Edit the
  user-facing notes in by hand afterwards if the release needs them.

## Making The Repository Public

Everything below is safe to leave until the day of the switch, and must be
done that day.

- Remove the self-hosted runner `studio-mac` (Settings -> Actions -> Runners).
  On a public repository a fork's pull request can edit a workflow to run on
  any self-hosted runner, and that Mac holds a login keychain. The release and
  preview workflows already switch to GitHub-hosted Macs by themselves once
  the repository is public (free there), so nothing else needs changing.
- Settings -> Actions -> General: set fork pull request workflows to require
  approval for all outside collaborators.
- `ci.yml` starts running on every pull request and push to `main` by itself --
  its jobs skip only while the repository is private. Make `Build`, `JS tests`
  and `Python tests` required checks on `main` in the branch protection rules.
- Set the repository variable `PREVIEW_SCHEDULE` to `enabled` to turn on the
  six-hourly preview builds.
- The `preview:mac` label (`desktop-preview.yml`) builds a DMG for pull
  requests from branches in this repository only; fork pull requests are
  refused by design.

## Smoke Test

- Install on a clean Windows machine or VM.
- Install on macOS Intel and Apple Silicon where available.
- Install on Linux using the AppImage.
- Launch the installed app.
- Confirm Help -> Check For Updates opens Settings and performs a visible update check.
- Confirm Settings shows version, channel, packaged state, and update status.
- Confirm bundled Python tools work:
  - `scripts/souls`
  - `scripts/sprintengine_tool.py`
- Confirm terminal sessions launch.
- Confirm Git panel reads status in a real repository.
- Confirm Sprint Engine boards can load existing state.
- Confirm protocol registration for `sprintengine://` auth callbacks still works,
  and that `multicode://` — still registered for links minted before the rename —
  reaches the same handler.

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
