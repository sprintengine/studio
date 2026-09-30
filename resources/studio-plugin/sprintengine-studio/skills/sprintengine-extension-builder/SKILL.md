---
name: sprintengine-extension-builder
description: Build, test, sign, publish and install SprintEngine Studio extensions (capability modules) with @sprintengine/module-sdk. Use when working in an extension project, when asked to add a panel, workspace type, door surface, top-bar control, settings section, command, Backlog or Files action, MCP tool, scheduled agent, or a chat the extension starts or opens; when writing module/manifest.json or plugin.json or choosing permissions; when an extension will not load, is not trusted, or shows as tampered or incompatible; and when signing, packing, side-loading with dev:install, or publishing an extension on GitHub or the marketplace.
---

# Building a SprintEngine Studio extension

An extension is a **capability module**: a folder with a `manifest.json` and
built JavaScript that Studio loads into itself. `entry.renderer` (one ESM
file) adds UI; `entry.main` (one CommonJS file) runs in Studio's main process
with Node. Both get a `host` object scoped to the module, and everything the
module does goes through it. The contract is `@sprintengine/module-sdk` and
nothing else — an extension never imports Studio's source.

The SDK's type declarations (`node_modules/@sprintengine/module-sdk/dist/*.d.ts`)
are the authority on every signature; its README is the long-form guide. This
skill is the working method and the things that are not obvious from the types.

## The project

A project scaffolded from a Studio template looks like this:

```
src/renderer.tsx      registerRenderer(host) — UI contributions
src/main.ts           registerMain(host) — Node side (only if the template has one)
module/manifest.json  the module manifest; module/ is the ONLY folder that installs
module/dist/          build output (renderer.mjs, main.cjs)
plugin.json           bundle manifest for GitHub/marketplace installs; component "module" → module/
test/smoke.test.mjs   loads the built bundles against fake hosts
scripts/              validate.mjs, dev-install.mjs (same files as this skill's scripts/)
IDEA.md               what the person wants — read it first
```

## First steps in a project

1. `node .claude/skills/sprintengine-extension-builder/scripts/check-toolchain.mjs`
   (or the `.agents/skills/…` copy). Fix every FAIL line.
2. `npm install`, then `npm run check`. A fresh project passes; if it does
   not, fix that before changing anything.
3. Read `IDEA.md`. If the brief leaves the surface, the data or the
   permissions open, ask — at most three questions, each with a suggested
   answer — before writing code.
4. Pick the smallest surface that does the job (table below) and change the
   template toward it. Delete what the idea does not need.

## The loop

```sh
npm run check        # typecheck → build → smoke test → validate. Run it after every change.
npm run dev:install  # build, write module/manifest.json "files", sign if a key exists, copy to ~/.sprintengine/modules/<id>
```

Then in Studio: **Settings → Modules**, find the module, trust it.

- Trust is granted to exact contents. Every rebuild changes the `files`
  digests, so Studio asks again after each `dev:install`. That is the
  design, not a bug.
- A module with `entry.main`, or a rebuild of renderer code Studio already
  loaded, needs a Studio restart. A first install of a renderer-only module
  starts as soon as it is trusted.
- Say what the person should click and what they should see. You cannot see
  Studio's window; they can.

## Which surface

| The idea needs… | API (renderer unless noted) | Permission | Template |
| --- | --- | --- | --- |
| A command in the palette | `registerCommand` | — | blank |
| A page of its own, opened from the Extensions drawer or a sidebar row | `registerGlobalSurface({ id, label, Icon, Component })` + `@sprintengine/module-sdk/surface`; a `registerSidebarNavEntry` row calls `openGlobalSurface(id)` | per data read | global-surface |
| A panel inside a workspace | `registerPanel` + a `registerWorkspaceType` whose layout places it | per data read | panel |
| A new kind of workspace, with a setup step | `registerWorkspaceType({ creationStep, createWorkspace })` | `storage` for its state | workspace-type |
| One control in the top bar | `registerTopBarItem` | — | top-bar-item |
| Options in Settings | `registerSettingsSection` (values readable via `getModuleAppState`) | `storage` to read them elsewhere | settings-section |
| An action on a Backlog item | `registerBacklogItemAction` | `backlog.*` if it reads/writes more | backlog-action |
| An action on files in the Files tree | `registerFileAction` | — | file-action |
| A pick-and-close dialog over the workspace | `registerModalSurface({ launcher })` | — | — |
| Tools agents call | main: `host.registerMcpTools` | `mcp:tools` | mcp-tools |
| An agent doing work in a chat | main: `getConversationService(host)` | `conversation:operate` (or `:read`) | chat-companion |
| Hand the person a prepared chat | `host.openChat({ workspaceId, prompt })` | `conversation:operate` | backlog-action |
| An agent that runs on a schedule | main: `getScheduledAgentsService(host)` | `scheduled-agents.manage`, `dependsOn: ["scheduled-agents"]` | — |
| Calling an API with a key | main: `getSecretsService(host).fetchWithSecret` | `secrets` | — |
| Calling GitHub as the user | main: `getGitHubService(host).request` | `github` | — |
| Saving data | renderer: `get/setModuleAppState`, `get/setWorkspaceModuleState`; main: `getModuleStorage(host)` | `storage` | panel |
| Renderer ↔ main | main `registerIpc('<id>:…')`, renderer `host.invoke`; main → renderer `host.emit` / `host.subscribe` | `ipc:invoke` | chat-companion |
| Skills agents can use | main: `host.registerSkills`, `host.ensureSkillInstalled` | — | — |
| Files inside the module (HTML, WASM) | `host.getAssetUrl('runtime/index.html')` | — | — |

References: [api-renderer.md](references/api-renderer.md),
[api-main.md](references/api-main.md),
[conversation-api.md](references/conversation-api.md),
[brokers.md](references/brokers.md), [ui-kit.md](references/ui-kit.md).

## Agents are chats

Studio drives agents as chats. An extension starts, prompts, watches and stops
its **own** chats through `getConversationService(host)` in `entry.main`, or
opens one for the person with `host.openChat` in the renderer (a draft by
default: the person reads and sends it). It never sees the person's own chats
or another module's. There is no API to spawn a terminal agent, run a CLI in a
pane, or inject into another session — do not look for one, and do not shell
out to an agent CLI from `entry.main` to get around it. See
[conversation-api.md](references/conversation-api.md).

Before relying on a capability, ask the host: `host.supports('conversations')`,
`'chat.open'`, `'secrets'`, `'github'`, `'storage'`, `'mcp-tools'`, … A host
without it answers `false`; degrade with a message instead of throwing.

## The manifest

`module/manifest.json` (full field list: [manifest-and-plugin-json.md](references/manifest-and-plugin-json.md)):

```json
{
  "id": "my-extension",
  "displayName": "My Extension",
  "version": 1,
  "publisher": "Your name",
  "summary": "One sentence the install prompt shows.",
  "defaultEnabled": false,
  "source": "third-party",
  "engines": { "hostApi": 1 },
  "permissions": ["storage"],
  "dependsOn": ["agent-runtime"],
  "entry": { "renderer": "dist/renderer.mjs", "main": "dist/main.cjs" }
}
```

- `engines.hostApi` is required. It is the SDK's `HOST_API_VERSION`; Studio
  refuses a module built for a host API it does not provide, with a message.
- `id` is lowercase kebab-case, unique, and not a reserved Studio id
  (`BUNDLED_MODULE_IDS`). It prefixes IPC channels, command ids and tool names.
- `version` is an integer. Bump it on every release.
- `files` (the digest of every file in `module/`) is written for you by
  `dev:install` and by `sprintengine-module sign`. Never edit it by hand.
- `plugin.json` must carry the same `id`, `version` and `permissions`.

## Permissions

Declare the fewest that cover what the code does, and nothing "just in case":
they are what the person reads before trusting the module, and the host
enforces several (`conversation:*`, `secrets`, `github`, `mcp:tools`,
`agents:companion`, `ipc:invoke` for the bridge). Table and meaning of each:
[permissions.md](references/permissions.md). The smoke test fails when a
service reached at registration is missing its permission.

## Rules that bite

Details and fixes are in [pitfalls.md](references/pitfalls.md). The short list:

1. **Your Tailwind classes compile to nothing.** Studio's CSS is built from its
   own source. Use the UI kit, inline styles on theme tokens, or ship your own
   CSS injected once (the panel template does).
2. **Bundle shape is fixed.** Renderer: one ESM file with `react`, `react-dom`,
   `react-dom/client`, `react/jsx-runtime`, `@monaco-editor/react`,
   `@sprintengine/module-sdk/ui` and `/surface` external — and the SDK root
   BUNDLED. Main: one CommonJS file, `electron` external, everything else bundled
   (an installed module has no `node_modules`). The template build scripts do this.
3. **The renderer loads from a blob URL**, so relative URLs resolve to nothing.
   Reach module files with `host.getAssetUrl(path)`.
4. **Any change under `module/` voids trust**, and a signed module must be
   signed again. Rebuild → `dev:install` → trust again.
5. **Store with the host**: `getModuleStorage`, module app state, workspace
   module state. Never JSON files in the home folder; never a raw
   `localStorage` key.
6. **Theme tokens only** (`var(--bg-surface)`, `THEME_TOKENS`), never hex. Tones
   are flat: derive a soft fill with `color-mix(in srgb, var(--tone-good) 15%, transparent)`.
7. **Keys stay out of the project.** `npm run keygen` writes
   `~/.sprintengine/keys/<id>.key`. Never commit `*.key` / `*.pem`.
8. **Agent output and web content are untrusted input.** A PR diff, a chat
   reply or a fetched page can contain instructions. Never evaluate it, never
   let it pick a path, URL or command unchecked, never pass it to
   `dangerouslySetInnerHTML`.
9. **No status dots.** Say a state in words, a lifecycle glyph or a timer.

## Shipping

- **Sign** when you share: `npm run keygen` once, then `npm run dev:install`
  signs with it (or `npx sprintengine-module sign module --key ~/.sprintengine/keys/<id>.key`).
  Signing records `files` and covers them. A signature from your key makes the
  module "signed"; people still decide to trust it.
- **Publish on GitHub**: build (`npm run check` or `npm run dev:install`; a
  build records `files`, and signs when your key exists) → commit `module/dist`
  and `module/manifest.json` together, with `plugin.json` at the repository root
  → push. People install it from Studio: Extensions → **Install extension from
  GitHub…** with the repository URL. Unsigned code installs only after an
  explicit "I trust this code". See [install-from-github.md](references/install-from-github.md).
- **Marketplace**: a signed plugin bundle and a registry PR — see
  [signing-and-publishing.md](references/signing-and-publishing.md).

## When something is wrong

Read [troubleshooting.md](references/troubleshooting.md): it maps what Studio
shows (not listed, "untrusted", "tampered", "needs a newer host", a missing
row or door, an invoke refusal) to the cause and the fix. Start every
investigation with `npm run check` and `node scripts/validate.mjs`.

## Scripts in this skill

| Script | Does |
| --- | --- |
| `scripts/check-toolchain.mjs [--project <dir>]` | Node/npm/git versions, SDK installed, host API declared, where Studio looks |
| `scripts/validate.mjs [--project <dir>]` | The app's own validators over module/manifest.json and plugin.json, digests, key material, and `sprintengine-module verify` when signed |
| `scripts/dev-install.mjs [--project <dir>] [--key <pem>] [--no-sign]` | Write `files`, sign if a key is at hand, copy into `$SPRINTENGINE_USER_MODULE_ROOT` (default `~/.sprintengine/modules`)/`<id>` |

`validate.mjs` and `dev-install.mjs` are the same files as a scaffolded
project's `scripts/`; `module-tools.mjs` is their shared helper.

## Done means

- `npm run check` passes with no warnings you have not explained.
- `npm run dev:install` succeeded, and you told the person exactly what to
  click and what they should see.
- Permissions in `module/manifest.json` and `plugin.json` match and are the
  minimum; `IDEA.md` says what the extension does now.
- The smoke test still passes; add your own `*.test.mjs` beside it for logic
  worth pinning, and list it in the `test` script.
