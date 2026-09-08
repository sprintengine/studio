# SprintEngine Studio

SprintEngine Studio is a desktop application for working with coding agents. It
runs the agent CLIs you already have — Claude Code, Codex, Cursor, OpenCode and
others — as terminals inside workspaces, keeps their sessions and history when
you close the window, and lets you run several of them at once against the same
repository. On top of that it adds sprints, which plan and carry a piece of work
through build and review, scheduled and triggered automations, an extension
marketplace, and a companion for driving the whole thing from a phone.

The app is an Electron desktop app with a React renderer, a TypeScript main
process, and a set of Python services for the sprint runtime.

<!-- SCREENSHOT: replace this block with an image of the workspace view, e.g. ![SprintEngine Studio](docs/images/screenshot.png) -->

_Screenshot to follow._

## Download

Prebuilt installers for macOS, Windows and Linux:

- <https://sprintengine.ai/download>
- <https://github.com/sprintengine/studio-releases/releases>

No account is needed to run it.

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

`npm run verify:app` spawns the Python services for real, so it also needs a
virtualenv:

```
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Python 3.12 is what CI uses, matching the CPython the app bundles. Plain
`npm run dev` does not need it.

## How the pieces are laid out

| Path | What is in it |
| --- | --- |
| `src/main` | The Electron main process: agent launch and state, terminal and conversation runtimes, the sprint runtime, the plugin registry, CLI detection and installation, MCP configuration, the workspace registry, and the IPC handlers. |
| `src/preload` | The preload bridge — the typed API surface the renderer is allowed to call. |
| `src/renderer` | The React user interface. |
| `src/shared` | Types and contracts shared across processes, including the IPC contract and the plugin and skill manifest schemas. Deliberately free of Node APIs. |
| `packages/module-sdk` | The published SDK for building capability modules and BYO-CLI plugins: manifest and permission types, host contribution points, and bundle signing. MIT licensed. |
| `sprintengine_core` | The Python sprint runtime — the local execution authority for task claiming, status changes, evidence and artifacts. |
| `sprintengine_mcp` | A Python MCP server over that runtime, so an agent can drive a sprint the same way a person can. |
| `resources/` | Everything bundled with the app rather than compiled into it: the agent CLI plugin manifests, the marketplace registry, MCP definitions, hooks, the studio plugin, the specialist role pack, the fetched agent runtimes, and the app icons. |
| `design-system/` | A self-contained, framework-neutral design system — tokens, components, patterns and a catalog — with its own lint that the app's build gates enforce. |
| `souls/` | The `souls` CLI: it renders a role's prompt from the Sprint Engine role registry. The roles themselves ship in `resources/specialist-pack/`. Being retired in favour of role skills — see [docs/souls.md](docs/souls.md). |

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
- **The sprint CLI and its MCP server** are documented in
  [docs/sprintengine-cli.md](docs/sprintengine-cli.md).

Both kinds of extension are built against
[`packages/module-sdk`](packages/module-sdk).

## Licence

The application is licensed under the **Functional Source License,
FSL-1.1-Apache-2.0** — you may use, modify and redistribute it for any purpose
except building a competing product, and each version converts to Apache 2.0 two
years after it is released. The full text is in [LICENSE](LICENSE).

Everything under `packages/` — the module SDK — is **MIT** instead, under its
own licence file, so you can build and ship extensions on any terms you like.
See [packages/module-sdk/LICENSE](packages/module-sdk/LICENSE).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the gates a pull request has to
pass, the design-system rule for anything visual, and the terms contributions
come in under. There is no CLA.

Please also read the [Code of Conduct](CODE_OF_CONDUCT.md). Security
vulnerabilities go through the private process in [SECURITY.md](SECURITY.md),
not the issue tracker.
