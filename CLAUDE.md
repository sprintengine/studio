# Free AI IDE — Claude Context

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

## Critical: Running the App from VSCode / Claude Code

VSCode (and any Electron host) sets `ELECTRON_RUN_AS_NODE=1` in its environment. This env var completely disables Electron's browser-process initialization — `require('electron')` returns the npm package path string instead of the Electron APIs, `process.type` is `undefined`, and nothing works.

**Always run the app via `npm run dev`**, which uses `scripts/dev.js` to clear this env var before spawning `electron-vite`. Never run `electron-vite dev` directly from a VSCode-hosted terminal.

## Conventions

- New panel types: add a `case` to the `factory` function in `WorkspaceLayout.tsx` and a matching `component` string in `templates.ts`.
- Never select the entire workspace in a panel component — always select the specific agent slice to avoid unnecessary re-renders during streaming.
- Tailwind dark palette: `zinc-950` backgrounds, `zinc-900` surfaces, `zinc-800` borders, `indigo-500/600` for agent accents.

## Swarm Coordination Tool

When working as a swarm specialist, prefer the repo-local `swarm-kanban` skill and the `swarm` command over manually editing `swarm/state.yaml`.

Canonical skill:

- `.agents/skills/swarm-kanban/SKILL.md`

Tool entry points:

- `swarm` (preferred inside swarm terminals)
- `python3 .agents/skills/swarm-kanban/scripts/swarm_tool.py`
- `python3 scripts/swarm_tool.py` (compatibility wrapper)

API discovery:

- When a swarm terminal starts, run `swarm --help`.
- Before using a subcommand for the first time, run `swarm <subcommand> --help` and follow the exact flags shown by the tool.
- Do not invent aliases. `append-evidence` uses repeatable `--file`, `--command`, and `--result`; it does not accept `--touched-files`, `--commands-ran`, or `--results`.
- Mailbox commands use `--from-agent`, `--to-agent`, `--subject`, and `--body`; there is no `--recipient`, `--message`, or `--team` flag.
- Agent identity is the stable swarm slot id such as `frontend`, `product`, `developer-1`, or `developer-2`, not the Claude session id. If Claude restarts, reuse the same `--agent-id` to continue that slot's active work.
- When calling the Python script directly, put global `--state <path>` before the subcommand.

Use it for:

- listing ready tasks for your role
- atomically claiming the next ready task for your role
- claiming a task
- moving your own task between `in_progress`, `needs_input`, and `done`
- appending notes and evidence
- printing the final run summary
- validating/replacing the task graph when acting as architect
- marking the final architect plan ready for approval
- creating or completing specialist consultation artifacts

Common commands:

```bash
swarm list-ready-tasks --role frontend
swarm claim-next-task --role frontend --agent-id frontend-1
swarm claim-task --task-id T3 --agent-id frontend-1
swarm set-task-status --task-id T3 --status in_progress --actor frontend-1
swarm append-evidence --task-id T3 --actor frontend-1 --summary "Updated board UI" --file src/renderer/src/components/panels/SwarmBoardPanel.tsx --file src/renderer/src/utils/swarm.ts --command "npm run typecheck" --result "Passed"
swarm run-summary
swarm validate-tasks --file swarm/tasks.json
swarm replace-tasks --actor architect --file swarm/tasks.json
swarm mark-plan-ready --actor architect
swarm create-consultation --request-id UX-001 --from-role architect --to-role frontend --title "Need UX input for approval flow" --task-id T4 --question "Where should plan approval live?" --question "How should waiting state be shown?"
swarm complete-consultation --request-id UX-001 --actor frontend --summary "Recommend a top-level approval banner." --recommendation "Use a persistent approval strip above the board." --recommendation "Keep task detail focused on execution."
```

Rules:

- only claim tasks that are ready for your role
- only update your own task card
- append evidence before marking work `done`
- use consultation artifacts when the architect needs specialist planning input
