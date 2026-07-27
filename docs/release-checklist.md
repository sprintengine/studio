# Multicode Release Checklist

Use this checklist for every preview or stable desktop release.

## Before Tagging

- Confirm `npm run typecheck` passes.
- Confirm `npm run test:main:mobile-sprintengine-command` passes.
- Confirm `npm run build` passes.
- Update `package.json` version.
- Draft release notes with user-visible changes, fixes, known issues, and rollback guidance.
- Confirm `.github/workflows/release.yml` can write GitHub Releases in repository settings.
- Confirm signing credentials are configured for any stable release.

## Retirements To State In Release Notes

Removals an installed profile cannot be migrated through. State each in the notes
of the first release that ships it, then delete the line.

- Sprint Engines panel shortcut (item 1813): the Sprint Engines panel became the
  Sprints door, and the `panel.sprint-engines.toggle` command went with it. A
  custom shortcut saved for that command stopped firing when the panel was
  removed; opening Settings -> Shortcuts now drops the saved binding. There is no
  replacement shortcut - the Sprints door opens from the sidebar.

## Tag And Build

- Create a tag matching `package.json`, for example `v0.2.0` or `v0.2.0-preview.1`.
- Push the tag to GitHub.
- Wait for `.github/workflows/release.yml`.
- Confirm release assets were published to `conal-smith/multicode` GitHub Releases.
- Confirm release assets include installers plus updater metadata such as `latest.yml`, `latest-mac.yml`, or Linux metadata when produced by `electron-builder`.

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
