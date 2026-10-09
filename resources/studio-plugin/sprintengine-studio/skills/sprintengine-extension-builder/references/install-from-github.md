# Installing from GitHub

People can install an extension straight from its repository: in Studio's
Extensions door, **Install extension from GitHub…**, paste the repository URL.
Studio resolves the default branch to a commit, reads `plugin.json` at the
repository root at that commit, shows what it found — name, publisher,
permissions, whether it is signed — and installs the `module/` folder the
bundle names. Updates compare the commit again and ask again when the
permissions or the signing change.

## What the repository must contain

```
plugin.json              at the root; components.module.path = "module"
module/manifest.json     with "files" (and "signature" if you sign)
module/dist/…            the BUILT bundles — commit them
```

The template is set up for this: its `.gitignore` keeps `module/dist/`, and
`npm run build` ends by recording `files` in `module/manifest.json` (and
signing it when `~/.sprintengine/keys/<id>.key` exists). It writes the manifest
only when the files changed, so after a rebuild of unchanged code git shows
nothing, and after a real change it shows the manifest beside `module/dist/`,
which is what to commit together. So:

1. Build: `npm run check`, or `npm run dev:install` to try it in Studio first
   (or `npx sprintengine-module sign module --key …` to sign by hand). Each
   leaves the manifest describing the build.
2. If you sign: `npx sprintengine-module plugin sign . --key …` after the
   module is signed.
3. `node scripts/validate.mjs` — clean, no stale-digest warning.
4. Commit `plugin.json`, `module/manifest.json` and `module/dist/` in one
   commit, and push.
5. Others install it: Extensions → **Install extension from GitHub…**, and the
   repository URL.

A `module/` whose files do not match its manifest's `files` is refused as
tampered, so never commit a rebuild without the manifest it produced — build,
then commit both.

Under the hood Studio resolves with `extensions:github:resolve` (the commit,
`plugin.json` there, and what it discloses), installs that exact commit with
`extensions:github:install`, and removes an installed module with
`modules:third-party:uninstall` (Settings → Modules → Uninstall).

## Signed or not

- **Signed** (a valid signature over `files`): installs through the normal
  trust prompt showing your key's fingerprint.
- **Unsigned, with code** (`entry.main` or `entry.renderer`): Studio warns that
  nobody vouches for the code and requires an explicit "I trust this code"
  choice before it installs. `files` is still required: it is what Studio
  holds the installed folder to.
- **Invalid** signature (changed after signing): refused.

## What is not an extension repository

A repository with `.claude-plugin/` (an agent-CLI plugin of skills and
commands) is a skill source, not a Studio extension: add it from the Skills
path, which is unchanged. And a `plugin.json` that describes an agent CLI is
not installable — Studio's agent runtimes ship with the app.

## Forks

A fork is a different repository and a different source: installing it is a
separate install, with its own trust decision. Keep the module `id` unless
the fork is meant to sit beside the original; two modules cannot share an id.
