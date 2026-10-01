# Signing and publishing

## What a signature does and does not do

`sprintengine-module sign` writes a detached ed25519 signature over the
validated manifest, which includes `files` — the digest of every file in
`module/`. So a signature says "this key vouches for exactly this code".

- Signed by a key Studio does not know: the module shows as **signed**, with
  the key's fingerprint, and the person still decides whether to trust it.
- Signed by a publisher key Studio ships in its trusted list: trusted without
  a prompt. Only first-party publishers are on that list.
- Unsigned: installable, with a clear warning and an explicit trust decision.
- Any change to `module/` after signing makes the signature invalid, and an
  invalid module is refused outright (not merely untrusted). Sign again.

## The key

```sh
npm run keygen    # sprintengine-module keygen --out ~/.sprintengine/keys/<id>.key
```

- The private key is a PKCS#8 PEM file, mode 600. It never goes in the
  project, never in git, never in CI logs. `pack` and the validators refuse
  `*.key` / `*.pem` files; `.gitignore` ignores them.
- Back it up. Losing it means publishing under a new fingerprint, and people
  who trusted the old one are asked again.
- In CI, keep it in a secret and write it to a temp file for the `sign` step.

## Sign, verify, pack

```sh
npm run build
npx sprintengine-module sign module --key ~/.sprintengine/keys/<id>.key   # writes files + signature into module/manifest.json
npx sprintengine-module verify module                                     # the app's own check: signature AND files
npx sprintengine-module pack module --out packed/<id>                     # an installable copy without keys or node_modules
```

`npm run dev:install` does the sign step for you whenever
`~/.sprintengine/keys/<id>.key` (or `$SPRINTENGINE_SIGNING_KEY`) exists.

## Release checklist

1. Bump `version` in `module/manifest.json` **and** `plugin.json`.
2. `npm run check`.
3. Sign the module (above), then the bundle:
   `npx sprintengine-module plugin sign . --key ~/.sprintengine/keys/<id>.key`
   and `npx sprintengine-module plugin verify .` — module first, because the
   bundle digests the module's signed manifest.
4. `node scripts/validate.mjs` — it runs both verifies.
5. Commit `module/manifest.json`, `module/dist/` and `plugin.json` together
   (the template's `.gitignore` keeps the build; see
   [install-from-github.md](install-from-github.md)), tag the release, push.

## Where people get it

| Channel | What they do | What you need |
| --- | --- | --- |
| Folder | Settings → Modules → "Install a module from a folder", pointing at `module/` (or `packed/<id>`) | Nothing more |
| GitHub | Install from GitHub with the repository URL | `plugin.json` at the repo root, `module/dist` committed — [install-from-github.md](install-from-github.md) |
| Marketplace | Find it in the Extensions door's Plugins view | A signed bundle and a registry pull request (below) |

## The marketplace registry

The catalogue is the `sprintengine/studio-releases` repository:

```
marketplace.json
icons/<id>.svg
plugins/<id>/plugin.json
plugins/<id>/module/…        # your signed module folder
```

1. Copy `plugin.json` and `module/` (after both are signed) into
   `plugins/<id>/`, and add `icons/<id>.svg`.
2. Add an entry to `marketplace.json`:
   ```json
   {
     "id": "<id>",
     "name": "<displayName>",
     "publisher": { "name": "<publisher>", "verified": false },
     "summary": "<summary>",
     "category": "Developer Tools",
     "icon": "icons/<id>.svg",
     "latest": 1,
     "source": "https://github.com/sprintengine/studio-releases/tree/main/plugins/<id>",
     "provides": ["module"],
     "signature": { "algorithm": "ed25519", "publicKey": "<from plugin.json>", "signature": "<from plugin.json>" }
   }
   ```
   `name`, `latest`, `provides` and `signature` must match the signed
   `plugin.json` exactly. `source` must be `https:` on github.com,
   api.github.com or raw.githubusercontent.com.
3. Open the pull request. Registry CI runs the same verifier Studio runs;
   listings reach people with the next catalogue release.

Community entries use `"verified": false`: people install them through the
trust prompt, which lists the permissions from the verified manifest.

## The SDK itself

Projects depend on `@sprintengine/module-sdk` from npm (`^1.0.0-beta.0` or
newer). To try an unreleased SDK, depend on a local tarball
(`"@sprintengine/module-sdk": "file:vendor/sprintengine-module-sdk-<v>.tgz"`)
— the scaffolder's `--sdk-tarball` option sets that up.
