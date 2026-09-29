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

The template's `.gitignore` ignores `dist/`. For a repository people install
from, delete that line (or add `!module/dist/`) and commit the build. Then:

1. `npm run check`.
2. Write `files`: `npm run dev:install` (unsigned, or signed when your key
   exists), or `npx sprintengine-module sign module --key …`.
3. If you sign: `npx sprintengine-module plugin sign . --key …` after the
   module is signed.
4. `node scripts/validate.mjs` — clean, no stale-digest warning.
5. Commit `plugin.json`, `module/manifest.json` and `module/dist/` in one
   commit, and push.

A `module/` whose files do not match its manifest's `files` is refused as
tampered, so never commit a rebuild without the manifest it produced.

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
