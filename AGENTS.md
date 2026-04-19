# Free AI IDE — Codex Context

## What This Is

An AI-first desktop IDE built with Electron + React. The primary purpose is managing **Swarms** of AI agents across isolated workspaces. Traditional IDE features (editor, file explorer) are secondary and optional per workspace.

## Tech Stack

| Layer | Library | Why |
|---|---|---|
| Shell | `electron-vite` (Electron + Vite) | Modern toolchain, fast HMR |
| UI | React 18 + TypeScript | Concurrent rendering for streaming |
| Styling | Tailwind CSS v4 + `@tailwindcss/vite` | Zero-config Vite plugin |
| Layout | `flexlayout-react` | JSON-serializable model = templates are just data |
| State | Zustand + Immer | Per-agent granular subscriptions, zero boilerplate |
| IDs | `nanoid` | Lightweight URL-safe IDs |

## Core Mental Model

```
App
└── WorkspaceManager          # tab bar + active workspace router
    ├── TemplateSelector      # modal shown when creating a new workspace
    └── WorkspaceLayout       # renders flexlayout Model for active workspace
        ├── AgentPanel        # one per agent slot; subscribes to its own state slice
        ├── EditorPanel       # placeholder
        └── FileExplorer      # placeholder
```

**Workspaces** are fully isolated environments. Switching tabs switches everything — layout, agents, history.

**Templates** are static JSON objects in `src/renderer/src/layouts/templates.ts`. Each defines a `flexlayout-react` `IJsonModel` (the panel tree) and `previewSlots` (for the SVG thumbnail in TemplateSelector). Adding a new template = one array entry, no component changes.

**Agents** live in `workspaceStore.agents[agentId]`. Each agent has `messages[]` (committed history) and `streamBuffer` (in-flight stream). `AgentPanel` selects only its own agent slice from Zustand — only that panel re-renders during a stream.

## Key Files

| File | Role |
|---|---|
| `src/renderer/src/types/workspace.ts` | All shared types |
| `src/renderer/src/layouts/templates.ts` | Template definitions — edit here to add layouts |
| `src/renderer/src/store/workspaceStore.ts` | Zustand store; `appendStream` / `commitStream` for streaming |
| `src/renderer/src/components/workspace/WorkspaceManager.tsx` | Root component — mount this in `App.tsx` |
| `src/renderer/src/components/workspace/WorkspaceLayout.tsx` | flexlayout `<Layout>` with component factory |
| `src/renderer/src/components/workspace/TemplateSelector.tsx` | New-workspace modal with SVG previews |
| `src/renderer/src/components/panels/AgentPanel.tsx` | Agent UI: message feed, streaming cursor, input |

## Streaming Pattern

```ts
// On each token from the AI provider:
appendStream(workspaceId, agentId, chunk)

// When the stream ends:
commitStream(workspaceId, agentId)
// → flushes streamBuffer into messages[], sets status = 'complete'
```

Only the target `AgentPanel` re-renders during streaming. Other panels are unaffected.

## Layout Model Stability

`WorkspaceLayout` holds the `flexlayout` `Model` instance in a `useRef`. It is created once per workspace mount. The JSON is synced back to the Zustand store on every drag/resize via `onModelChange`, so layout state survives re-renders but the Model object itself is stable.

## Critical: Running the App from VSCode / Codex

VSCode (and any Electron host) sets `ELECTRON_RUN_AS_NODE=1` in its environment. This env var completely disables Electron's browser-process initialization — `require('electron')` returns the npm package path string instead of the Electron APIs, `process.type` is `undefined`, and nothing works.

**Always run the app via `npm run dev`**, which uses `scripts/dev.js` to clear this env var before spawning `electron-vite`. Never run `electron-vite dev` directly from a VSCode-hosted terminal.

## Conventions

- New panel types: add a `case` to the `factory` function in `WorkspaceLayout.tsx` and a matching `component` string in `templates.ts`.
- Never select the entire workspace in a panel component — always select the specific agent slice to avoid unnecessary re-renders during streaming.
- Tailwind dark palette: `zinc-950` backgrounds, `zinc-900` surfaces, `zinc-800` borders, `indigo-500/600` for agent accents.

## Swarm Coordination Tool

Swarm specialists should prefer the repo-local `swarm-kanban` skill and the `swarm` command over hand-editing `swarm/state.yaml`.

Canonical skill:

- `.agents/skills/swarm-kanban/SKILL.md`

Tool entry points:

- `swarm` (preferred inside swarm terminals)
- `python3 .agents/skills/swarm-kanban/scripts/swarm_tool.py`
- `python3 scripts/swarm_tool.py` (compatibility wrapper)

Primary commands:

- `list-ready-tasks`
- `claim-next-task`
- `claim-task`
- `set-task-status`
- `add-note`
- `append-evidence`
- `run-summary`
- `validate-tasks`
- `replace-tasks`
- `mark-plan-ready`
- `create-consultation`
- `complete-consultation`

This tool is the intended coordination surface for:

- task claiming
- status updates
- evidence publishing
- final run summaries
- architect task graph validation/replacement
- architect plan readiness gating
- structured architect-to-specialist consultations

When a swarm terminal starts, it should read the repo-local skill first and then use `swarm` for board state changes.
