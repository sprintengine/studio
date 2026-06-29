# Backlog Plugin API

Backlog is Multicode's local intake surface for candidate work under
`backlog/`. Capability modules can extend it from the renderer through two host
registries:

- Backlog item actions: commands shown for a selected Backlog item.
- Backlog link providers: resolvers and openers for stored links on a Backlog
  item.

This document describes the implemented renderer contracts. Related durable
context lives in [[multicode/backlog]] and [[multicode/sprint-engine]]; the item
field schema (v2 frontmatter + the epic concept-file convention) is in
[`docs/backlog-item-schema.md`](./backlog-item-schema.md).

## Service Boundary

A Backlog item is split across two stores (see
[`docs/backlog-item-schema.md`](./backlog-item-schema.md) for the field schema):

- **Frontmatter** in the item's markdown file under `backlog/` is the source of
  truth for lifecycle and triage — `status`, `type`, `difficulty`,
  `criticality`, `risk`, and the up-pointing `epic:` slug. The shared writer
  `serializeBacklogFrontmatterFields` (`src/shared/backlog/frontmatter.ts`)
  rewrites it while preserving the document body byte-for-byte.
- **The object store** `.multi-code/backlog/items.json` holds only app-owned
  churn — links, the star/highlight, module-scoped metadata, and timestamps.

Both are mutated only through the named Electron API; the channel determines
which store it writes.

Frontmatter writers (rewrite the item `.md`, never `items.json`):

- `updateBacklogStatus(input)`
- `updateBacklogType(input)`
- `updateBacklogTriage(input)` — `difficulty`, `criticality`, and `risk`
- `updateBacklogEpic(input)` — sets/clears the child's `epic:` slug
- `createBacklogEpic(input)` — writes `backlog/epics/<slug>.md` with `type: epic`

Object-store writers (`.multi-code/backlog/items.json`):

- `readBacklogObjectStore(workspaceRoot)`
- `ensureBacklogObjectRecords(workspaceRoot, items)`
- `updateBacklogHighlight(input)`
- `addOrUpdateBacklogLink(input)`
- `updateBacklogModuleMetadata(input)`
- `moveBacklogObjectSource(input)`
- `removeBacklogObjectRecord(input)`

Renderer modules should use the action context helpers or `window.api` service
methods. They must not read or write `.multi-code/backlog/items.json` or item
frontmatter directly. Stored link target paths must stay project-root-relative,
for example `.multi-code/sprintengine/<team>/run.yaml`.

## Item Actions

Register item actions from a renderer module:

```ts
host.registerBacklogItemAction({
  id: 'my-module.action-id',
  label: 'Run action',
  category: 'execute',
  order: 20,
  isVisible: (context) => context.item.status !== 'archived',
  getState: (context) => context.readSource ? 'enabled' : 'disabled',
  run: async (context) => {
    const source = await context.readSource()
    await context.updateModuleMetadata('my-module', { lastRunAt: new Date().toISOString() })
  },
})
```

The renderer host records the owning module id. The Backlog panel filters
actions by module enablement before rendering them. Action ids must be unique.

`BacklogItemActionContext` provides:

- `workspaceId` and `workspaceRoot`
- `item`
- `readSource()`
- `updateStatus(status)`
- `addLink(link)`
- `updateModuleMetadata(moduleId, value)`
- optional `startSourcePlan(source)`

Use `updateModuleMetadata` for module-scoped data that belongs to the item but
is not part of Backlog's core status/type/triage/link model.

## Link Providers

A link provider owns one or more `target.kind` values. Registration fails if:

- The provider is registered by a different module than `provider.moduleId`.
- `targetKinds` is empty.
- `targetKinds` contains duplicates.
- Any target kind is already owned by another provider.

```ts
host.registerBacklogLinkProvider({
  moduleId: 'my-module',
  targetKinds: ['my-module.run'],
  resolveLinkStatus: async ({ link }) => ({
    ...link,
    status: 'active',
    canOpen: true,
  }),
  openLink: async ({ link }) => {
    return true
  },
})
```

`resolveLinkStatus` returns a `BacklogResolvedLink`:

- `status`: `active`, `completed`, `failed`, or `unknown`
- `canOpen`: `true` only when the provider can open the target now
- `unavailableReason`: user-visible explanation when `status` is `unknown`

`openLink` is optional. Returning `false` means the provider could not open the
target and the UI should treat the open attempt as unavailable. Throwing should
be reserved for unexpected failures; expected unavailable targets should return
`false` and publish or surface a diagnostic when appropriate.

If no enabled provider owns a link's target kind, Backlog resolves it to
`status: unknown`, `canOpen: false`, with an unavailable reason. Disabled modules
do not resolve or open their links.

## Link Status And Item Status

Backlog link status is separate from Backlog item status. The helper
`syncBacklogItemLinks` resolves provider-backed links and persists changed
non-unknown link status through `addOrUpdateBacklogLink`.

Only execution links can move item lifecycle:

- Any active execution link moves a non-archived item to `in_progress`.
- All execution links completed moves a non-archived item to `completed`.
- Unknown, failed, and non-execution links leave item status unchanged.

Unknown resolutions are rendered but never persisted, so a transient unreadable
target does not overwrite a known stored status.

## Sprint Engine Run Links

Sprint Engine owns the built-in `sprintengine.run` provider. It resolves status
from `readSprintEngineProjection(statePath)` plus normalized Sprint Engine
projection data. Backlog must not parse Sprint Engine task folders, artifact
folders, locks, events, or other run-store internals.

The provider accepts only safe project-root-relative targets shaped like:

```text
.multi-code/sprintengine/<team>/run.yaml
```

Absolute paths, drive-letter paths, UNC paths, traversal paths, `run.yml`, and
non-run-store paths are unavailable before any projection read or workspace
focus.

A readable run with at least one task and every task `done` resolves to
`completed`; readable nonterminal or empty runs resolve to `active`; missing,
unreadable, unavailable, or malformed projections resolve to `unknown`.

For already-linked items, the normal primary action is Open Sprint Engine, not
Start Sprint Engine. Existing active or completed `sprintengine.run` links hide
the Start Sprint Engine action to avoid duplicate run creation. Starting another
run should be a separate explicit path, not the primary Backlog action.

Sprint Engine projection refresh also reconciles completed linked runs through
the Backlog service: after a successful normalized completed projection, it
matches links for the current workspace run and persists link/item completion
through `addOrUpdateBacklogLink`. Failed reads or writes warn and leave Backlog
status unchanged.

## Agent Terminal Links

The always-on `agent-runtime` core module owns the built-in `agent.terminal`
provider — the bidirectional link between a Backlog item and the agent terminal
working it. These links use the dedicated `agent` link **type**, which is
lifecycle-neutral: like all non-execution links it never moves item status, so a
live agent terminal cannot flip a `completed` item back to `in_progress`.
Completion authority stays with the Backlog item status (set by the backlog
skill), never the terminal's liveness.

The link is written at the handoff moment — dragging a `backlog/...` file into an
agent terminal, or the row "Send to agent" action. The link target id is the
composite `<workspaceId>/<agentId>`, the only durable navigation key (PTY and CLI
session ids are reaped or change across relaunch). A fixed link id means
re-handing an item to a different agent replaces the link rather than
accumulating stale ones. Worktree agents are excluded — they receive plain-path
pastes and must not fork the Backlog object store.

Resolve reports `active` when the agent's workspace is open and the agent still
exists; otherwise `unknown` with a visible reason. Opening activates the agent's
workspace and focuses its terminal tab, exposed both as the detail-pane link row
and an `Open agent` item action. The reverse direction (a glyph on the agent
terminal that selects the item in the Backlog panel) is driven by
`AgentState.backlogItemRef` and a dedicated reveal latch, internal to the app
rather than part of this plugin contract.

## Permissions

Bundled modules are first-party. Third-party capability modules declare
permission strings in their manifest for install/trust disclosure. Permission
validation accepts string scopes; these are install-time disclosure shown
before you trust a module, not a runtime-enforced cage — there is no runtime
Backlog permission broker, and these scopes do not gate `backlog-service` IPC.

Defined Backlog-related disclosure scopes (part of the capability-permission
vocabulary, with consent descriptions, alongside the `ipc:*` tiers):

- `backlog.read`: read Backlog item metadata and source paths.
- `backlog.write`: mutate Backlog item status, metadata, links, or records.
- `backlog.link.open`: open external or module-owned targets from Backlog links.

Modules that only contribute read-only link status should not need
`backlog.write`. Modules that persist link status, item status, or module-scoped
metadata should declare `backlog.write`. A link provider whose `openLink` can
focus workspaces, spawn external processes, or open network resources should
also declare the corresponding workspace/process/network capability scopes when
those actions apply.

These scopes are disclosure vocabulary only: they declare what a module says it
does and surface readable consent text at install/trust time. They make no
runtime enforcement claim, so describe them to users as disclosure, never as a
sandbox or permission gate the app enforces.
