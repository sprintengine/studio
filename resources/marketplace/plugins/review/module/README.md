# Reviews — a SprintEngine Studio extension

Guided, human-led review of a pull request, branch, or patch. A guide agent reads the change
and writes the walkthrough; you review it beside the diff and ask the guide questions.

This repo is a **capability module** for SprintEngine Studio, built only against
`@sprintengine/module-sdk`. It installs from the Extensions door (or from
`~/.sprintengine/modules/review/`) and never compiles against the app's source.

See `DESIGN.md` for the architecture and `SDK-FINDINGS.md` for every SDK gap this module hit.

## Develop

```
npm install
npm run check          # typecheck + tests + build
npm run dev:install    # build, sign with your dev key, copy to ~/.sprintengine/modules/review
```
Restart SprintEngine Studio to pick up a rebuilt module. Signing needs a key whose public
half is trusted by the app — the release key, or a dev key listed in the app's
`resources/marketplace/trusted-publishers.dev.json` (source builds only).

## Install (users)

Open **Extensions** in SprintEngine Studio. The "Power your reviews" card installs the module;
so does the **Reviews** entry in the Plugins catalogue, and the "Install Reviews" button that
appears if something opens the Reviews surface before it is installed. Restart the app once
after installing — modules load at launch. Reviews then appears in every workspace pane's
launcher (letter **R**) and its "+" menu.

Your reviews live in each project at `.sprintengine/review/<id>/` and survive uninstalling the
module.

## Release (maintainers)

```
npm run check                  # typecheck + tests + build
npm run sign                   # signs manifest.json with the release key
npm run bundle                 # bundle/review/{plugin.json,module/} + bundle/registry-entry.json
```
Commit the signed `manifest.json`. Copy `bundle/review/` to `plugins/review/` in
`sprintengine/studio-releases` and the app's `resources/marketplace/plugins/review/`, and
`bundle/registry-entry.json` into both `marketplace.json` files (the entry's `signature` must
equal the bundle's). Bump `version` in `manifest.json` for every release; the registry's
`latest` follows it.

The release key's public half is listed in the app's `resources/marketplace/trusted-publishers.json`
under "SprintEngine Labs"; that is what lets this module claim the reserved id `review`.
