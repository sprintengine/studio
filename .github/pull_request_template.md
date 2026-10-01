<!--
Use a Conventional Commit title (see CONTRIBUTING.md):
feat: add workspace search              -> minor release
fix(updates): retry interrupted downloads -> patch release
feat!: remove the legacy workspace format -> major release
All other accepted types release a patch. Squash merge preserves this title
and the PR body; use ! or a BREAKING CHANGE: footer for an incompatible change.
-->

### What changed and why

### How it was checked

- [ ] `npm run verify:app` is green
- [ ] If the change is user-visible: checked in the running app (`npm run dev`), and said how above
- [ ] If it crosses the tailnet or mobile wire: read `docs/compatibility.md`
