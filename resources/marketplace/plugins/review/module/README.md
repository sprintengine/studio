# Reviews — a SprintEngine Studio extension

Guided, human-led review of a pull request, branch, or patch. A guide agent reads the change
and writes the walkthrough; you review it beside the diff and ask the guide questions.

This repo is a **capability module** for SprintEngine Studio, built only against
`@multicode/module-sdk`. It installs from the Extensions door (or from
`~/.multicode/modules/review/`) and never compiles against the app's source.

See `DESIGN.md` for the architecture and `SDK-FINDINGS.md` for every SDK gap this module hit.

## Develop

```
npm install
npm run check          # typecheck + tests + build
npm run dev:install    # build, sign with your dev key, copy to ~/.multicode/modules/review
```
Restart SprintEngine Studio to pick up a rebuilt module. Signing needs a key whose public
half is trusted by the app — the release key, or a dev key listed in the app's
`resources/marketplace/trusted-publishers.dev.json` (source builds only).
