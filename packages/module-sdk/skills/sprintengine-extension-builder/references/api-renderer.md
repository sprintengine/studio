# Renderer API (`entry.renderer`)

`export const registerRenderer: RegisterRenderer = (host) => { … }` runs once,
when Studio loads the module into a window (each window loads it). Register
everything there; components get `host` by closure (every template uses a
`createX(host)` factory for that). Types: `RendererHost` in
`@sprintengine/module-sdk`.

Registration may be async (return a promise); Studio waits up to 10 seconds,
and a rejection or a timeout is a load error, the same as a throw. Registering
the same id twice, or an id another module holds, is a load error too, and it
turns off the module's other contributions — keep ids prefixed with the module
id.

## Identity and capabilities

| Member | Notes |
| --- | --- |
| `hostApiVersion` | The host API Studio provides. |
| `supports(capability)` | `'conversations'`, `'chat.open'`, `'storage'`, `'secrets'`, `'github'`, `'module-assets'`, … Unknown names answer `false`. Check before relying on a newer capability. |
| `getAssetUrl(relativePath)` | A stable `studio-module:` URL for a file inside the installed module (no leading slash, no `..`). The way to reach HTML, images, WASM: the bundle itself runs from a blob URL, so relative URLs do not resolve. |

## Contributions

| Method | What appears | Gone when the module is off? |
| --- | --- | --- |
| `registerCommand({ id, title, category, scopes, run, availability?, defaultKeybindings? })` | Command palette entry, id namespaced `<moduleId>.<id>`. `scopes: ['global']` for anywhere; `panel:<moduleId>` while a workspace of your type is active. | yes |
| `registerPanel(componentId, Component)` | Nothing by itself: a panel shows only where a layout tab names it (`component: componentId`). Pair with a workspace type. Props: `{ workspaceId }`. | yes |
| `registerWorkspaceType(definition)` | A workspace kind in the creation hub. `createTemplate()` returns the layout; `openOnFirstLoad` opens a folderless one on first load; `creationStep` adds a setup page; `createWorkspace(request, create)` owns creation (mint with `create.createWorkspace()`, roll back with `create.removeWorkspace(id)`); `supervisors` mount render-nothing background components; `deriveRunGlyph` sets the sidebar status; `rowActions` add row menu items. | yes |
| `openWorkspace(typeId)` | Create or focus the module's zero-config workspace type. Use from a command so people can reopen it. | — |
| `registerGlobalSurface({ id, label, Icon, Component, views?, railPlacement?, onOpen? })` | A full-page "door". With `label` + `Icon`, the shell lists it in the Extensions drawer and on the Extensions home: that row is how people open it. `views` splits it into several rows. | shows a "not installed" door |
| `registerModalSurface({ id, label, Component, launcher? })` | A dialog floated over the window. `launcher: { label, letter, Glyph }` adds a row to each workspace pane's "+" menu, the one trigger the shell draws; the body gets `{ workspaceId }`. | closes |
| `openGlobalSurface(id)` / `openModalSurface(id)` | Open one of THIS module's surfaces from your own trigger (a nav row, a panel button, a command). `false` for an id you did not register, or while the module is off. | — |
| `registerTopBarItem({ id, order, Component })` | One compact control in the top bar. | yes |
| `registerSidebarNavEntry({ id, order, Component })` | A row component in the sidebar's top nav; `Component` gets `{ collapsed }` (icon-only when true). Its click usually calls `openGlobalSurface(id)` — the global-surface template registers one. | yes |
| `registerDoorBadge({ rowId, getWaitingCount, subscribe })` | A waiting count on a drawer / nav row. | yes |
| `registerSettingsSection({ id, label, icon, Component })` | A Settings section. `Component` gets `{ values, setValue }`; values live in the module's settings namespace, which `getModuleAppState(key)` also reads. | yes |
| `registerBacklogItemAction({ id, label, category, run, isVisible?, getState?, order? })` | A Backlog item menu action. `run(context)` gets `{ workspaceId, workspaceRoot, item, readSource, updateStatus, addLink, updateModuleMetadata }`. | yes |
| `registerBacklogLinkProvider({ moduleId, targetKinds, resolveLinkStatus, openLink? })` | Resolves the status of links your module adds to items. | yes |
| `registerFileAction({ id, label, run, getLabel?, isVisible?, getState? })` | A Files-tree menu action over the selection: `{ workspaceId, workspaceRoot, entries: [{ name, path, isDir }] }`. | yes |
| `registerNotificationActionProvider({ source, resolveActions })` | "Open" actions on bell rows your module emitted. | yes |

## Chats

| Method | Notes |
| --- | --- |
| `openChat({ workspaceId, prompt?, skills?, cli?, model?, send?, name?, dedupeKey? })` | Opens and focuses a new chat in the workspace. Default `send: false`: the prompt is a draft the person sends. `name` titles the chat; `dedupeKey` focuses the chat this module already opened under that key (`existing: true`) instead of opening another. Resolves `{ ok: true, agentId, existing? }` or `{ ok: false, code, message }` (`permission_missing`, `unknown_workspace`, `workspace_folder_missing`, `cli_not_conversational`, `unavailable`, `invalid_input`) — never throws for those. A draft needs `chat:draft` (or `conversation:operate`); `send: true` needs `conversation:operate`. `name`/`dedupeKey`: `supports('chat.open-options')`. |
| `listChatRuntimes()` | `[{ id, label, available, models, lastSelected }]` for a picker; pass `id` as `cli`. |
| `focusTab({ workspaceId, kind: 'chat' \| 'file', id })` | Focus a chat by agent id (from `openChat` or the conversation service) or a file by workspace-relative path. |

For chats the module drives itself (send, watch, stop), use the main-side
conversation service: [conversation-api.md](conversation-api.md).

## Workspaces and files

| Method | Permission | Notes |
| --- | --- | --- |
| `getWorkspace(id)` | `ipc:workspace-read` | `{ id, name, folderPath, mode }` or `null` ("not resolvable yet" — retry, never treat as deleted). |
| `listWorkspaces()` / `watchWorkspaces(cb)` | `ipc:workspace-read` | `watch` fires at once with the current list, then on change. |
| `getWorkingRoot(id)` | `ipc:workspace-read` | Where live work happens (a worktree, for worktree-backed workspaces). |
| `watchWorkspaceFile(id, relativePath, cb)` | `filesystem:read-workspace` | Content now, then debounced on change; resolves to the unsubscriber. |
| `listBacklogItems(id)` / `watchBacklogItems(id, cb)` | `backlog.read` | Read-only item views. |

## State

| Method | Permission | Use for |
| --- | --- | --- |
| `getModuleAppState(key)` / `setModuleAppState(key, value)` / `watchModuleAppState(cb)` | `storage` | The module's own small settings-like values; synchronous, safe to read in render; pair with `useSyncExternalStore`. `set` returns `false` when not stored. |
| `getWorkspaceModuleState(id)` / `setWorkspaceModuleState(id, value)` | `storage` | The module's entry on one workspace, saved and synced with it. `undefined` = unknown yet. |
| `watchColorScheme(cb)` | — | `'light' \| 'dark'` for a runtime you host (Monaco, a chart); ordinary UI uses theme tokens. |

Larger data, or data `entry.main` writes: `getModuleStorage(host)` in main,
reached from the renderer through your own IPC channel.

## Talking to entry.main

```ts
// main
host.registerIpc(`${host.moduleId}:save`, async (_event, payload) => ({ ok: true }))
host.emit('changed')                       // push a signal to every window
// renderer
const result = await host.invoke('my-extension:save', { text })
useEffect(() => host.subscribe('changed', () => void reload()), [])
```

- Channels must start with `<moduleId>:`; the host refuses others. The owner
  must declare `ipc:invoke`. A refused invoke rejects with an Error whose
  `code` is `unknown_channel`, `not_bridgeable` or `permission_missing`.
- Events are signals, not state: nothing is replayed, so read the current
  state through a channel and let the event say "read again".
- Payloads cross IPC: structured-cloneable values only.

## Drag and drop

`readFileDropPayload(event.dataTransfer)` reads Backlog/Files drags (`null` for
anything else); `hasFileDropData` is the `dragover` check;
`setFileDropData` starts a drag Studio's own targets accept.
