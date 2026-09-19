# Backlog Plugin API

Backlog is the studio's local intake surface for candidate work under
`backlog/`. Capability modules can extend it from the renderer through two host
registries:

- Backlog item actions: commands shown for a selected Backlog item.
- Backlog link providers: resolvers and openers for stored links on a Backlog
  item.

This document describes the implemented renderer contracts. The item field
schema (v2 frontmatter + the epic concept-file convention) is in
[`docs/backlog-item-schema.md`](./backlog-item-schema.md).

## Service Boundary

A Backlog item is split across two stores (see
[`docs/backlog-item-schema.md`](./backlog-item-schema.md) for the field schema):

- **Frontmatter** in the item's markdown file — `backlog/<epic-slug>/<item>.md`,
  or `backlog/unfiled/` when it has no epic — is the source of truth for
  lifecycle and triage (`status`, `type`, `difficulty`, `criticality`, `risk`,
  and the up-pointing `epic:` slug) and for the durable app-written facts: the
  star (`starred`, `highlight`) and the declared link (`pr`). The shared
  writer `serializeBacklogFrontmatterFields` (`src/shared/backlog/frontmatter.ts`)
  rewrites it while preserving the document body byte-for-byte.
- **The link cache** `<sidecar>/backlog/cache/links.json` holds only what is
  volatile — resolved link status, the agent terminal holding an item,
  module-scoped metadata, and its own timestamps. It is gitignored (the folder
  carries its own `.gitignore`, so it stays invisible in any project) and
  re-derivable: deleting it costs a lookup, never data. `<sidecar>` is the
  workspace's app-owned directory, `.sprintengine`.

Both are mutated only through the named Electron API; the channel determines
which store it writes.

Frontmatter writers (rewrite the item `.md`, never the cache):

- `updateBacklogStatus(input)`
- `updateBacklogTriage(input)` — `difficulty`, `criticality`, and `risk`
- `updateBacklogEpic(input)` — sets/clears the child's `epic:` slug
- `updateBacklogEpicColor(input)` — the epic's identity colour
- `updateBacklogDependencies(input)` — the `dependsOn` CSV
- `updateBacklogMockups(input)` — the `mockups` CSV
- `createBacklogEpic(input)` — writes `backlog/epics/<slug>.md` with `type: epic`
- `ensureBacklogItemIds(input)` — stamps missing numeric ids

There is no `updateBacklogType` on the bridge. Setting an item's `type` exists
only in-process (`backlogService.updateBacklogType`, reachable from the MCP and
mobile surfaces); the renderer has no channel for it.

Cache writers (`<sidecar>/backlog/cache/links.json`) — `updateBacklogHighlight`
and `addOrUpdateBacklogLink` also write the durable half into the item's
frontmatter:

- `ensureBacklogObjectRecords(workspaceRoot, items)`
- `updateBacklogHighlight(input)`
- `addOrUpdateBacklogLink(input)`
- `updateBacklogModuleMetadata(input)`
- `removeBacklogLink(input)`
- `moveBacklogObjectSource(input)`
- `removeBacklogObjectRecord(input)`

Renderer modules should use the action context helpers or `window.api` service
methods. They must not read or write `<sidecar>/backlog/cache/` or item
frontmatter directly. A stored link target that names a file must stay
project-root-relative, for example `<sidecar>/modules/<moduleId>/state.json` —
never an absolute path, which stops meaning the same thing the moment the
project is cloned somewhere else.

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
- `getLabel(context)` and `selection: { items, projectItems }` — the
  multi-selection surface. An action offered on a multi-selection must
  handle `selection` in both `isVisible` and `run`.
- optional `startSourcePlan(source)` — renderer-internal only; it is **not** on
  the `BacklogItemActionContext` published by `@sprintengine/module-sdk`, so a
  third-party module cannot type-reference it.

`category` is a closed union: `execute`, `analyze`, `transform`, `publish`,
`review`, `organize`.

`context.item` for an SDK module is `BacklogItemView`, which widens the enums to
`string` and deliberately omits `risk`, `epic`, `dependsOn`, `highlight`,
`mockups`, `numericId` and `displayId`.

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

- `status`: `pending`, `active`, `completed`, `canceled`, `failed`, or
  `unknown`
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

- Any active execution link moves a non-archived leaf item to `in_progress`.
- All execution links completed moves a non-archived leaf item to `completed`.
- Unknown, failed, and non-execution links leave item status unchanged.
- An **epic** short-circuits all of that: when `epicChildStatuses` is present
  `nextBacklogItemStatusFromLinks` reflects the children's highest-precedence
  status, and the epic's own active execution link only contributes an
  `in_progress` vote — it can never complete the epic.

Unknown resolutions are rendered but never persisted, so a transient unreadable
target does not overwrite a known stored status.

## The Pull Request Link

The Backlog owns one built-in link of its own, so it survives every module:
module id `backlog`, target kind `backlog.pullRequest`, link id
`backlog:pull-request` — or `backlog:pull-request:<repoId>` when the pull request
belongs to a sibling project rather than the item's own. The fixed id is what
makes it idempotent: re-recording a pull request replaces the link instead of
accumulating stale ones, and a sibling's link replaces only itself.

It is built by `buildBacklogPullRequestLink` in
`src/shared/backlog/durable-links.ts`, which is the only place its label, id
scheme and target shape are specified — a caller that hand-assembled one would be
the thing that drifts. Its frontmatter half is the `pr` scalar: `<url>` for the
item's own project, `<repoId>=<url>` for a sibling.

The link's **type** is `external`, which is lifecycle-neutral, so attaching a
pull request never moves the item's status. That is deliberate: an open pull
request is not a claim about whether the work is done, and completion authority
stays with the item's own status.

Opening it is an external open — the URL goes to the system browser. There is no
in-app store to mount, which is the whole reason a durable link fits in a
frontmatter scalar: nothing about it needs reconstructing except the URL a person
already decided on.

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
