# Backlog Plugin API

Backlog is Multicode's local intake surface for candidate work under
`backlog/`. Capability modules can extend it from the renderer through two host
registries:

- Backlog item actions: commands shown for a selected Backlog item.
- Backlog link providers: resolvers and openers for stored links on a Backlog
  item.

This document describes the implemented renderer contracts. Related durable
context lives in [[multicode/backlog]] and [[multicode/sprint-engine]].

## Service Boundary

Backlog source files stay under `backlog/`. App-owned item metadata lives in
`.multi-code/backlog/items.json` and is mutated through the named Electron API:

- `readBacklogObjectStore(workspaceRoot)`
- `ensureBacklogObjectRecords(workspaceRoot, items)`
- `updateBacklogStatus(input)`
- `updateBacklogType(input)`
- `updateBacklogTriage(input)`
- `addOrUpdateBacklogLink(input)`
- `updateBacklogModuleMetadata(input)`
- `moveBacklogObjectSource(input)`
- `removeBacklogObjectRecord(input)`

Renderer modules should use the action context helpers or `window.api` service
methods. They must not read or write `.multi-code/backlog/items.json` directly.
Stored link target paths must stay project-root-relative, for example
`.multi-code/sprintengine/<team>/run.yaml`.

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

## Permissions

Bundled modules are first-party. Third-party capability modules declare
permission strings in their manifest for install/trust disclosure. Current
permission validation accepts string scopes and does not yet enforce a runtime
Backlog permission broker.

Expected Backlog-related scopes for future third-party modules:

- `backlog.read`: read Backlog item metadata and source paths.
- `backlog.write`: mutate Backlog item status, metadata, links, or records.
- `backlog.link.open`: open external or module-owned targets from Backlog links.

Modules that only contribute read-only link status should not need
`backlog.write`. Modules that persist link status, item status, or module-scoped
metadata should declare `backlog.write`. A link provider whose `openLink` can
focus workspaces, spawn external processes, or open network resources should
also declare the corresponding workspace/process/network capability scopes when
those actions apply.

Do not document these scopes as a user-facing permission UI until enforcement
and presentation are implemented.
