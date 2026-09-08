# Multicode Release Checklist

Use this checklist for every preview or stable desktop release.

## Before Tagging

- Confirm `npm run typecheck:all` passes. That is what `release.yml`'s validate
  job runs; plain `typecheck` skips the test projects, which is how 99 test
  typecheck errors sat on `main` unnoticed before 0.4.0. Delete any stale
  `tsconfig.*.tsbuildinfo` first, or an incremental build can report clean.
- Confirm `node scripts/testing/run-tests.mjs src/main/mobile/sprintengine/command.test.ts` passes.
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
- Confirm `RELEASES_TOKEN` exists under Settings -> Secrets and variables ->
  Actions. Releases go to the PUBLIC `sprintengine/studio-releases`, and the
  workflow's own `GITHUB_TOKEN` cannot write to another repo. Without it the
  `validate` job now stops the release before anything is built.
- Draft release notes with user-visible changes, fixes, known issues, and rollback guidance.
- Update the download site's release-notes data to the version being released.
  The download page only renders What's New when its `version` equals the
  version it is serving, so notes left on the previous version do not go stale
  on screen -- they vanish from the page entirely.
- Confirm signing credentials are configured for any stable release.

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
  type in `@multicode/module-sdk`. This is a **breaking type change** for a
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

## Tag And Build

- Create a tag matching `package.json`, for example `v0.4.0` or `v0.4.0-preview.1`.
- Push the tag to GitHub.
- Wait for `.github/workflows/release.yml`.
- Confirm release assets were published to the PUBLIC
  `sprintengine/studio-releases` GitHub Releases -- NOT to `sprintengine/studio`,
  which is private and which neither the updater nor the website can read. The
  `verify-published` job checks this now; v0.3.0 shipped to the private repo
  and reported success because nothing did.
- Confirm release assets include installers plus updater metadata such as `latest.yml`, `latest-mac.yml`, or Linux metadata when produced by `electron-builder`.
- Write the release body by hand in `studio-releases`. Never use GitHub's
  "generate release notes" there: it would list private commit messages.

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
- Confirm protocol registration for `multicode://` auth callbacks still works.

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
