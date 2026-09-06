# Multicode

AI-first IDE and agent command center. Multicode is a desktop application that
combines a code workspace with an orchestration layer for autonomous coding
agents — Sprint Engine (multi-agent task lifecycle), Switchboard/Watchtower
(coordination and review), and a library of role-based agent prompts and skills.

> **Proprietary and confidential.** See [LICENSE](./LICENSE). This source is not
> open for redistribution or derivative use.

## Stack

- **Desktop shell:** Electron + electron-vite
- **Renderer:** React + TypeScript + Tailwind CSS
- **Agent runtime / tooling:** Python (`requirements.txt`)

## Requirements

- Node.js (see `package.json` engines / `.nvmrc` if present) and npm
- Python 3 with the dependencies in `requirements.txt`

## Getting started

```bash
npm install
pip install -r requirements.txt   # agent runtime tooling
npm run dev                        # launch the app in development
```

## Common scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the app in development |
| `npm run typecheck` | TypeScript type checking |
| `npm run lint` | Design-token, panel, palette, and primitive lint checks |
| `npm test` | Full app verification suite (`verify:app`) |
| `npm run build` | Build renderer + main and check bundle budget |
| `npm run dist` | Build and package distributables via electron-builder |

## Repository layout

- `src/` — Electron main, preload, and React renderer
- `souls/`, `resources/studio-plugin/studio-skills/skills`, `resources/skill-packs` — agent role prompts and skills (bundled)
- `sprintengine_core/`, `switchboard_core/` — Python agent-orchestration cores (bundled)
- `resources/` — bundled hooks, MCP catalog, plugins, and skill packs
- `scripts/` — dev, build, and lint tooling
- `docs/` — product and developer documentation

## Packaging

Distribution artifacts are produced by `electron-builder` (`npm run dist`). The
`build.files` / `build.extraResources` whitelist in `package.json` controls
exactly what is bundled into the shipped binary; internal-only directories
(design explorations, planning notes, marketing, and the brand knowledge base)
are intentionally excluded.
