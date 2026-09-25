# SprintEngine Studio

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

SprintEngine Studio is a desktop application for working with coding agents. It
runs the agent CLIs you already have — Claude Code, Codex, Cursor, OpenCode and
others — as terminals inside workspaces, keeps their sessions and history when
you close the window, and lets you run several of them at once against the same
repository. On top of that it adds a file-backed backlog, code review, a design
system door, a memory graph, scheduled and triggered automations, an extension
marketplace, and a companion for driving the whole thing from a phone.

The app is an Electron desktop app with a React renderer and a TypeScript main
process.

<!-- SCREENSHOT: replace this block with an image of the workspace view, e.g. ![SprintEngine Studio](docs/images/screenshot.png) -->

_Screenshot to follow._

## Running it

Build it from source — see [CONTRIBUTING.md](CONTRIBUTING.md) for the toolchain
and `npm run dev`. No account is needed to run it.

Prebuilt installers for macOS, Windows and Linux are not published yet.

### Uninstalling

Studio writes a few things outside its own data so the agent CLIs it launches
can report to it: hooks and an MCP server entry in the repositories you open,
a hook in Kimi Code's user config, `tailscale serve` mappings for ports you
shared, locks on agent worktrees, and the same inside any WSL distribution it
ran agents in. Each one runs a small launcher at `~/.sprintengine/bin`, so a
leftover never breaks a CLI — but you will want them gone.

- **Windows.** Uninstall Studio from Settings > Apps. The uninstaller removes
  all of it first, and asks whether to delete Studio's settings and logs too.
- **macOS and Linux.** Open Settings > General > Studio's integrations >
  Remove… first. It lists everything it will take out, grouped by where it is,
  removes only what Studio wrote (your own hooks, servers and settings around it
  stay), and can delete Studio's data when it quits. Then delete the app (or the
  AppImage). The same removal runs without a window when the app's binary is
  started with `--remove-integrations` — on macOS
  `"/Applications/SprintEngine Studio.app/Contents/MacOS/SprintEngine Studio" --remove-integrations`,
  on Linux the AppImage with the same flag. It exits 0 when everything was
  removed and 2 when something could not be, and refuses (exit 4) while
  Studio is running.

Every run of the removal is recorded in `integration-removal.log` in Studio's
data folder, and it is safe to run again.

## The agent CLIs it drives

Each of these ships as a plugin manifest under `resources/plugins/`, which is
what the app reads to find, launch and update the CLI. The CLI itself is not
bundled — the app detects the binary on your `PATH` and can install or update it
for you.

| Agent CLI | Binary |
| --- | --- |
| Claude Code | `claude` |
| Codex | `codex` |
| Cursor | `cursor-agent` |
| Grok Build | `grok` |
| Kimi Code | `kimi` |
| Muse Code | `muse` |
| OpenCode | `opencode` |
| Kimi K3 | `claude`, pointed at Moonshot |
| Z.AI | `claude`, pointed at Z.AI |
| Generic Shell | `sh`, for driving any command-line program as an agent |

Alongside those, three model providers are available for the app's own
conversation agents: the Claude Agent SDK harness, OpenRouter and xAI.

Adding another CLI does not require changing the app. A plugin manifest is
enough — see [docs/plugin-authors/README.md](docs/plugin-authors/README.md).

## Building from source

You need **Node 22** (there is a `.nvmrc`) and npm.

```
git clone https://github.com/sprintengine/studio.git
cd studio
npm ci
npm run dev
```

`npm run dev` starts the main process and the renderer dev server together. It
uses port 5173, or the next free port if that one is taken, in which case the
second instance gets its own profile so you can run two side by side.

```
npm run build          # compile main, preload and renderer, and check the bundle budget
npm run dist:mac       # package an installer — also dist:win, dist:linux
npm run verify:app     # the full gate: typecheck, lints, tests, SDK and feed checks
```

The `dist:*` scripts fetch the bundled agent runtimes first, so the first run of
one needs network access and takes a while.

## How the pieces are laid out

| Path | What is in it |
| --- | --- |
| `src/main` | The Electron main process: agent launch and state, terminal and conversation runtimes, the capability-module host, the plugin registry, CLI detection and installation, MCP configuration, the workspace registry, and the IPC handlers. |
| `src/preload` | The preload bridge — the typed API surface the renderer is allowed to call. |
| `src/renderer` | The React user interface. |
| `src/shared` | Types and contracts shared across processes, including the IPC contract and the plugin and skill manifest schemas. Deliberately free of Node APIs. |
| `packages/module-sdk` | The published SDK for building capability modules and BYO-CLI plugins: manifest and permission types, host contribution points, and bundle signing. MIT licensed. |
| `resources/` | Everything bundled with the app rather than compiled into it: the agent CLI plugin manifests, the marketplace registry, MCP definitions, hooks, the studio plugin and its skills, the fetched agent runtimes, and the app icons. |
| `design-system/` | A self-contained, framework-neutral design system — tokens, components, patterns and a catalog — with its own lint that the app's build gates enforce. |

## Extending it

The app is meant to be built on rather than only used.

- **Capability modules** contribute to the main and renderer hosts — new
  workspace types, automation providers, notifications, panels. Start with
  [docs/module-authors/drop-in-extensions.md](docs/module-authors/drop-in-extensions.md)
  for how the app discovers a module you drop on disk, and
  [docs/module-authors/permissions.md](docs/module-authors/permissions.md) for
  what the permission vocabulary means.
- **CLI plugins** teach the app to drive an agent CLI it has never seen: how to
  launch it, how to write its MCP config, how to install skills for it, and how
  to tell when a turn is finished.
  [docs/plugin-authors/README.md](docs/plugin-authors/README.md) covers manifests
  and signed bundles.
- **The studio's own agent-facing surface** — the `sprintengine-studio` plugin
  the app installs into every workspace it opens, the stdio bridge to the
  running app, and the skills that teach an agent to drive it — is documented in
  [resources/studio-plugin/README.md](resources/studio-plugin/README.md).

Both kinds of extension are built against
[`packages/module-sdk`](packages/module-sdk).

## Licence

The repository is licensed under the **MIT License**. You may use, modify and
redistribute it, including in commercial products. The full text is in
[LICENSE](LICENSE).

`packages/module-sdk` and `packages/mobile-control-protocol` carry their own
MIT licence files as well, so an SDK consumer does not have to take the whole
application tree.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the gates a pull request has to
pass, the design-system rule for anything visual, and the terms contributions
come in under. There is no CLA.

Please also read the [Code of Conduct](CODE_OF_CONDUCT.md). Security
vulnerabilities go through the private process in [SECURITY.md](SECURITY.md),
not the issue tracker.
