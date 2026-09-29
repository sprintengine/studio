# Reviews — a SprintEngine Studio extension

Guided, human-led review of a pull request, branch, or patch. A guide agent reads the change
and writes the walkthrough; you review it beside the diff and ask the guide questions.

This repo is a **capability module** for SprintEngine Studio, built only against
`@sprintengine/module-sdk` (host API 1). It never compiles against the app's source.

The guide runs as an ordinary **chat** in the workspace you opened Reviews from, on the
`none` permission preset: the change it reads is someone else's text, so every tool call
that is not already allowed waits for your approval in that chat.

See `DESIGN.md` for the architecture and `SDK-FINDINGS.md` for every SDK gap this module hit.

## Install (users)

Reviews ships with SprintEngine Studio's first-party extensions. If it is not installed:

- open **Extensions** and install **Reviews** from the catalogue, or
- use Extensions' install-from-GitHub option with the signed release bundle,
  `https://github.com/sprintengine/studio-releases/tree/main/plugins/review`. (This repo is
  the source; its root is not an installable bundle — `npm run bundle` builds one.)

Restart the app once after installing — modules load at launch. Reviews then appears in every
workspace pane's launcher (letter **R**) and its "+" menu. Reviews is signed by the
SprintEngine Labs key the app trusts for the reserved id `review`.

Your reviews live in each project at `.sprintengine/review/<id>/` and survive uninstalling the
module.

## Develop

```
npm install
npm run check          # typecheck + tests + build
npm run dev:install    # build, sign with your DEV key, copy to ~/.sprintengine/modules/review
```

`dev:install` signs with a dev key only — `$SPRINTENGINE_DEV_SIGNING_KEY`, else
`~/.sprintengine/keys/review.key` (create one with
`npx sprintengine-module keygen --out ~/.sprintengine/keys/review.key`). It never falls back
to the release key and refuses one that is the release key. List the dev key's public half in
the app's `resources/marketplace/trusted-publishers.dev.json` (source builds only), then
restart SprintEngine Studio to pick up the rebuilt module.

The SDK is vendored as `sprintengine-module-sdk-1.0.0-beta.0.tgz` because 1.0.0-beta.0 is not
on npm yet. Once it is published, switch `package.json` to `"@sprintengine/module-sdk":
"^1.0.0-beta.0"` and delete the tarball.

## Release (maintainers)

```
npm run check          # typecheck + tests + build
npm run sign           # release key: writes `files` digests + signature into manifest.json
npm run verify         # check again, then confirm manifest.json matches the build
npm run bundle         # bundle/review/{plugin.json,module/} + bundle/registry-entry.json
```

`npm run sign` signs the staged module (`packed/review/`: `manifest.json`, `dist/`, `skills/`,
`README.md`) with the release key at `~/.config/sprintengine/keys/reviews-signing.key` and
writes the signed manifest back to `manifest.json`; `npm run bundle` re-stages, verifies, and
signs `plugin.json` with the same key. Commit the signed `manifest.json`. Copy `bundle/review/`
to `plugins/review/` in `sprintengine/studio-releases` and the app's
`resources/marketplace/plugins/review/`, and `bundle/registry-entry.json` into both
`marketplace.json` files (the entry's `signature` must equal the bundle's). Bump `version` in
`manifest.json` for every release; the registry's `latest` follows it.

The release key's public half is listed in the app's `resources/marketplace/trusted-publishers.json`
under "SprintEngine Labs"; that is what lets this module claim the reserved id `review`.
