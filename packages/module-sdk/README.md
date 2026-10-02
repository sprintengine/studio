# @sprintengine/module-sdk

The contract, templates and authoring CLI for building **SprintEngine Studio
extensions** (capability modules): the manifest and its host API version, the
`MainHost` / `RendererHost` registration contracts, chat conversations with the
app's agents, brokered secrets and GitHub access, scheduled agents, module
storage, notifications, and signing.

Studio is a home for agent runtimes — Claude Code, Codex and the ACP agents —
and an extension reaches those agents one way: **as chats**. A module starts,
drives and reads chat conversations it owns, opens a chat for the person with a
drafted prompt, or runs a background companion agent. It never launches,
types into, or watches an agent terminal; that surface is not part of the SDK.

The package is types-first. Beyond the declarations it ships a few small pure
values (`BUNDLED_MODULE_IDS`, `KNOWN_CAPABILITY_PERMISSIONS`,
`HOST_API_VERSION`, `createServiceToken`, the `get*Service` helpers), the
manifest validators, the `sprintengine-module` CLI, the starter templates and
the `sprintengine-extension-builder` agent skill. It has no runtime dependency
on Electron or on the app's code, so a project compiles against the tarball
alone. Node 22.15 or newer.

## Quick start

```sh
npx -p @sprintengine/module-sdk sprintengine-module init my-extension --template panel
cd my-extension
npm install
npm run check        # typecheck, build, smoke test, validate
npm run dev:install  # side-load into Studio on this machine
```

`init <dir> --template <id> [--id <module-id>] [--name <display name>]`
scaffolds a project that already builds, passes its own smoke test and installs.
`--sdk-tarball <file>` depends on a local SDK build instead of the npm release
(for working on the SDK itself). Templates:

| Template | What it starts you with |
| --- | --- |
| `blank` | A palette command and nothing else: the smallest extension that runs |
| `panel` | A notes panel in a workspace of its own, saved in module app state |
| `global-surface` | A full-page surface behind its own row, drawn with the host's door shell |
| `top-bar-item` | A compact control in the app's top bar |
| `settings-section` | A section in Settings, and a command that reads what it saved |
| `workspace-type` | A workspace type with a creation step |
| `backlog-action` | A Backlog item action that opens a planning chat for the item |
| `file-action` | A Files-tree context-menu action |
| `mcp-tools` | Tools any agent in a workspace calls through the Studio MCP gateway |
| `chat-companion` | Starts and follows chats of its own, and opens chat drafts with `openChat` |

Studio can do the same from the Extensions door: **Build your own extension**
opens New chat in extension mode. You name the extension, pick the project it
goes in and describe it (or start from one of the ideas, one per template);
Studio scaffolds `<project>/<name>` from the `blank` template and opens a chat
on it with the agent you pick and the extension-builder skill, which adds the
surfaces your description needs.

### The extension-builder skill

Every scaffolded project carries the `sprintengine-extension-builder` skill in
`.claude/skills/` and `.agents/skills/` (the package ships it under `skills/`).
It is the working method for an agent building an extension — the project
layout, which host API to reach for, choosing permissions, the check /
side-load loop, signing, publishing, and what "not trusted", "tampered" and
"incompatible" mean — with references for the main and renderer APIs,
conversations, brokers, the UI kit and troubleshooting. Point your agent at it:
"Use the sprintengine-extension-builder skill."

### Project layout

```
src/renderer.tsx      registerRenderer(host) — UI contributions
src/main.ts           registerMain(host) — Node side (templates that need one)
module/manifest.json  the module manifest; module/ is the only folder that installs
module/dist/          build output (renderer.mjs, main.cjs)
plugin.json           the bundle manifest a GitHub or marketplace install reads;
                      its "module" component points at module/
IDEA.md               the brief
```

## What an extension is

A folder with a `manifest.json` (`CapabilityManifest`) and built JavaScript:

- **`entry.renderer`** — a single-file ESM bundle exporting
  `registerRenderer(host)`. Adds UI.
- **`entry.main`** — a CommonJS bundle exporting `registerMain(host)`. Runs in
  Studio's main process with Node.
- **`entry.preload`** is reserved and never loaded.

Both registration functions may be `async`: the host waits for the returned
promise (bounded at 10 seconds) before it counts the module as loaded, and a
rejection or a timeout fails that module alone.

The manifest fields that matter most:

| Field | Notes |
| --- | --- |
| `id` | `^[a-z0-9][a-z0-9-]{0,62}$`, equal to the install folder name, not one of `BUNDLED_MODULE_IDS`. |
| `version` | Positive integer. |
| `source` | `"third-party"`. |
| `engines` | `{ "hostApi": 1 }` — **required**. See "Host API version". |
| `permissions` | What the module touches; shown before anyone trusts it. |
| `dependsOn` | Module ids that load first, e.g. `scheduled-agents`, `agent-runtime`. |
| `entry` | `{ "renderer": "dist/renderer.mjs", "main": "dist/main.cjs" }`. |
| `files` | Written by `sign` / `dev:install`: every file's sha256. **Required** to load. |
| `signature` | Written by `sign`. |

**Trust.** Only a module the person trusts runs code. A valid signature from a
publisher key shows who vouches for it; the person still grants trust. A grant
binds to the manifest's fingerprint, which covers `files`, so it holds only
while the installed folder matches them byte for byte. Studio checks the files
when it lists modules, again immediately before it runs `entry.main`, and on
every `entry.renderer` and asset it serves.

## Host API version

`HOST_API_VERSION` names the host contract this SDK describes, as one integer;
this release has `HOST_API_VERSION = 1` and `HOST_API_MIN_SUPPORTED = 1`. A third-party manifest must declare the version it was built
against:

```json
"engines": { "hostApi": 1 }
```

Studio loads a module when that number is within
`[HOST_API_MIN_SUPPORTED, HOST_API_VERSION]` of the app, and otherwise refuses
it with a message saying which side to update (`host_api_missing`,
`host_api_too_new`, `host_api_too_old`). `checkHostApiCompatibility(manifest)`
is the same check, exported; `sprintengine-module sign`, `verify` and `pack`
run it too.

The version says which contract a module was built for. What the running host
provides *today* is a separate question, and every host answers it:

```ts
if (host.supports('conversations')) registerChatFeatures(host)
```

`host.hostApiVersion` is the app's `HOST_API_VERSION`; `host.supports(name)`
is true for a capability the host provides now — a service can be missing
because the module that provides it is turned off. Names: `conversations`,
`chat.open`, `companion-agents`, `scheduled-agents`, `secrets`, `github`,
`storage`, `mcp-tools`, `skills`, `module-assets`, `notifications`. An unknown
name answers `false`, so a module may probe for capabilities newer than its
SDK.

## Permissions

Declare what the module touches in `permissions`. They are install-time
disclosure: the consent prompt lists them before the person trusts the module.
Most are not a sandbox — trusted code runs in the app's process — but these are
checked on every call, and a module without them gets `permission_missing`:

| Permission | Checked on |
| --- | --- |
| `conversation:read` | `getConversationService`: `subscribe`, `transcript`, `list`, `watch` |
| `conversation:operate` | Everything in the conversation service, and `RendererHost.openChat`. Implies read. |
| `conversation:bypass` | Running the module's chats on `bypass`; without it they go no looser than `auto` |
| `secrets` | `getSecretsService` |
| `github` | `getGitHubService` |
| `mcp:tools` | `MainHost.registerMcpTools` |
| `agents:companion` | Attaching a companion agent |
| `ipc:invoke` | The renderer → `entry.main` bridge (`RendererHost.invoke`) |

The full vocabulary and its consent copy is in
[`docs/module-authors/permissions.md`](../../docs/module-authors/permissions.md)
in the app repository, and `KNOWN_CAPABILITY_PERMISSIONS` exports it.

## Chats with the app's agents

### From `entry.main`: the conversation service

```ts
import { getConversationService, type RegisterMain } from '@sprintengine/module-sdk'

export const registerMain: RegisterMain = (host) => {
  if (!host.supports('conversations')) return
  const chats = getConversationService(host)

  host.registerIpc('my-module:ask', async (_event, workspaceId: string) => {
    const created = await chats.create({
      workspaceId,
      prompt: 'Summarise what changed on this branch.',
      skills: ['my-review-guide'], // installed before the first turn and invoked in it
    })
    if (!created.ok) return created // { ok: false, code, message }
    const { conversation } = created
    const off = chats.subscribe(conversation, (event) => {
      if (event.type === 'turn_completed') off()
    })
    return { ok: true, agentId: conversation.agentId }
  })
}
```

Declare `conversation:operate` (or `conversation:read` for a module that only
reads its chats) and `dependsOn: ["agent-runtime"]`.

- **`create(input)`** starts a chat in a workspace: `cli` and `model` default
  to the person's last choice, `prompt` is the opening turn, `skills` are
  installed and invoked, `attachments` are images, `name` is optional.
  `permissionPreset` is `'manual'`, `'none'`, `'auto'` or `'bypass'`; absent
  takes the person's default.
- **`send(ref, { message, skills?, attachments?, steer? })`** adds a turn;
  `steer: true` lands it inside the turn already running. `interrupt` and
  `stop` do what they say.
- **`respondToApproval(ref, { requestId, decision, answers? })`** answers an
  `approval_requested` event: `decision` is `'once'`, `'conversation'` (allow
  requests of that kind for the rest of the chat) or `'deny'`. The older
  `approved: boolean` still works, as `'once'` or `'deny'`. A rule that
  outlives the chat is the person's to make, so no answer makes one.
- **`setPermissionPreset(ref, preset)`** and **`setModel(ref, modelId)`**
  switch a running chat's preset (from its next tool call) or its model (from
  its next turn; an id `listChatRuntimes()` lists for the chat's runtime, or
  `'default'`). Each answers with what is now in force, plus the runtime's
  `notice` when the change applies later than at once. A runtime that binds a
  chat to its model refuses `setModel`.
- **The preset ceiling.** A module's chats run no looser than `'auto'` unless
  its manifest declares `conversation:bypass`. A looser preset is lowered to
  the ceiling, not refused, and `create` and `setPermissionPreset` name the
  preset in force. Check `host.supports('conversation-controls')` before
  `setPermissionPreset`, `setModel`, a `decision`, or a preset other than
  `'none'` and `'bypass'`.
- **`answerQuestion(ref, { requestId, answers })`** answers a question the
  agent asked, and **`resolvePlan(ref, { requestId, decision })`** carries a
  plan out (`'approve'`) or sends the agent back to planning (`'reject'`).
  Each is refused for a request of another kind. Check
  `host.supports('conversation-requests')`; an older host takes a question's
  answers on `respondToApproval`, which `answerQuestion` falls back to.
- **CLI modes and allowed tools.** `create` and `setPermissionPreset` take the
  agent CLI's own `permissionMode` beside the preset (Claude Code's
  `'acceptEdits'`), which goes with a preset lowered to the ceiling; `create`
  also takes `allowedTools`, tools the chat uses without asking, which needs
  `conversation:bypass`. Check `host.supports('conversation-permissions')`.
- **`commandId`.** Every mutating call but `stop` takes your own id for it. A
  retry with the same id, even after the app restarted, is answered with the
  first call's result and never carried out twice; a retried `create` answers
  with the chat the first one made. Check `host.supports('conversation-streams')`.
- **`subscribe(ref, cb)`** streams `ModuleConversationEvent`s from now on;
  **`follow(ref, cursor, onFrame)`** streams with no gap: a `snapshot` (or,
  given the `afterSeq` and `generation` of events you already hold, only the
  ones after them), one `synchronized` fence, then live events. Render what
  you cached, then follow from its cursor; keep each fence's `seq` and
  `generation` as the next cursor. A snapshot with `reset: true` replaces what
  you held. Check `host.supports('conversation-streams')`.
  **`transcript(ref)`** replays everything recorded. **`list(filter?)`** and
  **`watch(filter, cb)`** give `ModuleConversationSummary` rows.
- A module reaches **only the chats it created** — never the person's own and
  never another module's (`not_owned`). Its chats are otherwise ordinary: they
  appear in the sidebar and on paired devices like any other.
- Failures come back as `{ ok: false, code, message }` with a
  `ModuleConversationErrorCode`, never a throw.

### From the renderer: open a chat for the person

```ts
const runtimes = host.listChatRuntimes() // [{ id, label, available, models, lastSelected }]
const opened = await host.openChat({
  workspaceId,
  prompt: 'Review the open pull request against our style guide.',
  skills: ['my-review-guide'],
})
if (opened.ok) host.focusTab({ workspaceId, kind: 'chat', id: opened.agentId })
```

`openChat` adds a chat to the workspace and focuses it. By default the prompt
lands in the composer as a **draft** the person reads and sends; `send: true`
sends it as the first turn. Declare `conversation:operate`; check
`host.supports('chat.open')` first (`unavailable` means this window cannot
open chats). `listChatRuntimes()` is the catalog the shell's own chat picker
reads, with the person's last choice marked — use it for a picker, and pass the
chosen `id` / model as `cli` / `model`.

`focusTab({ workspaceId, kind, id })` focuses a chat by its agent id
(`kind: 'chat'`) or a file tab by workspace-relative path (`kind: 'file'`).
It returns `false` for an id that is not a chat in that workspace.

### Companion agents

`getCompanionAgentsService(host)` attaches a workspace-bound background agent
your module drives with structured runs (`runStructured`) and messages, without
a chat tab. `attach` never starts anything; the first run does. Declare
`agents:companion`.

## Brokered credentials

### Secrets

```ts
import { getSecretsService } from '@sprintengine/module-sdk'

const secrets = getSecretsService(host)
await secrets.set('weather-api', apiKey, { allowedOrigins: ['https://api.weather.example'] })
const res = await secrets.fetchWithSecret('weather-api', 'https://api.weather.example/v1/today', {
  placement: { header: 'Authorization', scheme: 'Bearer' },
})
if (res.ok) render(JSON.parse(res.body))
```

A stored value never comes back to module code — not from `has`, not in a
response, not in an error. It leaves the host only inside a `fetchWithSecret`
request to one of the https origins it was stored with (exact origin, bound at
`set`; change the list by setting the value again). Requests refuse redirects
and cap the response at 1 MiB. Values are encrypted with the operating
system's keychain; where it has none, `set` answers `storage_unavailable`.
Declare `secrets`; check `host.supports('secrets')`.

### GitHub

```ts
import { getGitHubService } from '@sprintengine/module-sdk'

const github = getGitHubService(host)
const { signedIn } = await github.status()
const pulls = await github.request({
  route: '/repos/{owner}/{repo}/pulls',
  params: { owner: 'acme', repo: 'app', state: 'open' },
})
```

The request goes to the GitHub API with the person's own sign-in; the module
never sees the token. `route` is a `/`-prefixed template: `{name}` placeholders
are filled from `params` (encoded, so a value cannot add a segment, a query or
a host) and the rest of `params` becomes the query string. Anything that could
move the request elsewhere is `invalid_route`. Declare `github`; check
`host.supports('github')`.

## The main host

`MainHost` (handed to `registerMain`):

- `moduleId`, `hostApiVersion`, `supports(capability)`.
- `registerIpc(channel, handler)` — a channel your renderer calls through
  `invoke`; it must start with `<moduleId>:`.
- `provideService` / `getService` / `requireService(token)` — the service bridge. A
  third-party module resolves only the services the SDK publishes (its
  exported tokens and the ones behind the `get*Service` helpers).
- `onStartup`, `onShutdownBegin` and `onShutdown` hooks.
- `registerSidecar(spec)` — a declaration the host lists; it does not spawn it.
  Spawn your own process if you need one (declare `process:spawn`).
- `notify({ severity, title, body? })` — a bell notification, stamped with your
  module's identity and flood-bounded.
- `emit(topic, payload?)` — a module event to your own renderer (below).
- `registerMcpTools(tools)` — tools agents call through the always-on Studio
  MCP gateway, owned by your module id. Declare `mcp:tools`. A tool counts as
  changing state unless it declares `mutates: false`; declare that only on a
  tool that genuinely reads. A disabled module's tools stay listed and answer
  an enable error instead of running.
- `registerSkills(skills)` / `ensureSkillInstalled(workspaceRoot, skillId)` —
  see "Skills a module ships".

## The renderer host

`RendererHost` (handed to `registerRenderer`). Every contribution is gated on
your module's enablement, so turning it off removes it without a reload; an id
another module already holds is a registration error that fails your module's
load.

- **Where you appear:** `registerPanel`, `registerWorkspaceType`,
  `registerSidebarNavEntry`, `registerGlobalSurface`, `registerModalSurface`,
  `registerTopBarItem`, `registerSettingsSection`, `registerCommand`,
  `registerBacklogItemAction`, `registerBacklogLinkProvider`,
  `registerFileAction`, `registerNotificationActionProvider`,
  `registerDoorBadge`.
- **Opening your own surfaces:** `openGlobalSurface(id)` and
  `openModalSurface(id)` open a surface **your module registered** — the page
  behind your door, or your modal over the window — from a command, a panel
  button or a notification action. Both return `false` for an id that is not
  yours, not registered, or while your module is off. The shell draws no
  trigger for a modal surface unless you declare a `launcher` (a row in the
  workspace pane's kind list), so these are how you open one.
- **Workspaces:** `getWorkspace`, `listWorkspaces`, `watchWorkspaces`,
  `getWorkingRoot`, `watchWorkspaceFile`, `openWorkspace(typeId)`
  (declare `ipc:workspace-read`; `filesystem:read-workspace` for file watches).
- **Chats:** `openChat`, `listChatRuntimes`, `focusTab` (above).
- **State:** `getWorkspaceModuleState` / `setWorkspaceModuleState` (your entry
  on a workspace, synced across windows) and `getModuleAppState` /
  `setModuleAppState` / `watchModuleAppState` (app-level, shared with your
  Settings section's values). Declare `storage`.
- **Backlog:** `listBacklogItems`, `watchBacklogItems` (declare `backlog.read`).
- **Theme:** `watchColorScheme(cb)` for a runtime you host (Monaco, a chart
  library); ordinary UI reads `THEME_TOKENS`.
- **Bridge and events:** `invoke(channel, payload)` and `subscribe(topic, cb)`.
- **Assets:** `getAssetUrl(relativePath)`.

The TSDoc on each member in `dist/index.d.ts` is the reference for its exact
behaviour.

## Calling your entry.main from the renderer

```ts
// entry.main
export const registerMain: RegisterMain = (host) => {
  host.registerIpc('my-module:save-events', async (_event, payload) => {
    // Node APIs available here
    return { saved: true }
  })
}

// entry.renderer
const result = await host.invoke('my-module:save-events', { events })
```

The channel must start with your own module id. The host routes an invoke only
to a channel registered through `registerIpc` whose owner declares
`ipc:invoke`. A refused invoke rejects with an Error whose `code` is a
`ModuleBridgeRefusalCode` (`unknown_channel` | `not_bridgeable` |
`permission_missing`).

**This bridge is a contract, not a security boundary.** All renderer code runs
in one world; trust gating is the boundary.

## Module events (main → renderer)

`MainHost.emit(topic, payload?)` pushes to your own
`RendererHost.subscribe(topic, cb)`. Only your module's subscribers receive
it; one emit reaches every open window, in order per module. **Nothing is
replayed**: keep the durable answer readable through an IPC channel and let
the event say "read it again". Payloads must be structured-cloneable; delivery
pauses while your module is off.

## Module storage

`getModuleStorage(host)` → `get` / `set` / `delete` / `list`, keyed per module
and optionally per workspace. Workspace keys live under the workspace's
`.sprintengine/modules/<moduleId>/`, global keys under the app's data; JSON
values up to 1 MB, atomic writes. Declare `storage` and
`dependsOn: ["agent-runtime"]`.

## Workspaces from entry.main

```ts
import { WorkspaceContextToken, WorkspaceServiceToken } from '@sprintengine/module-sdk'

const created = await host.requireService(WorkspaceServiceToken).create({ name: 'Scratch', folderPath: '/abs/path' })
const view = await host.requireService(WorkspaceContextToken).get(workspaceId) // { id, name, folderPath, mode } | null
```

`create` resolves once the workspace is confirmed, so a returned id is real.
The context service (declare `ipc:workspace-read`) also has `list()`.

## Scheduled agents

A scheduled agent is a prompt and a cron schedule: each time the schedule
comes round, a new chat starts in the project with that prompt as its first
message, on the CLI, model, permissions, skills, MCP servers and worktree
setting it was made with. Nothing carries from one run to the next. A module
creates its own with `getScheduledAgentsService(host)` (declare
`scheduled-agents.manage` and `dependsOn: ["scheduled-agents"]`). Every method
is scoped to your module: `list` returns only yours, and `update`, `remove`
and `runNow` refuse an id you did not create. They appear in the person's
sidebar like the ones they make themselves, and they can close them.

```ts
import { getScheduledAgentsService, type RegisterMain } from '@sprintengine/module-sdk'

export const registerMain: RegisterMain = (host) => {
  host.registerIpc('weather-deck:schedule-refresh', async (_event, folderPath: string) => {
    const created = await getScheduledAgentsService(host).create({
      prompt: 'Refresh the forecast notes for the watched city.',
      schedule: { cron: '0 9 * * 1-5', timezone: 'Europe/Dublin' },
      folderPath,
      hostId: null,
      cli: 'claude-code',
      cliModel: null,
      permissionPreset: null,
      skills: [],
      mcpServers: [],
      worktree: null,
    })
    return created.ok ? created.agent.id : null
  })
}
```

## Skills a module ships

```ts
host.registerSkills([
  { id: 'my-review-guide', sourceDir: 'skills/my-review-guide', targetPolicy: 'all-native', description: 'Walk a reviewer through a change.' },
])
```

`sourceDir` is relative to your module root and must stay inside it. An id a
built-in skill or another module holds is a registration error, and unloading
your module takes its skills with it. `'agents'` installs into
`.agents/skills/<id>`; `'all-native'` also into every installed agent's own
skill directory — pick it whenever a prompt invokes the skill by name. A skill
you pass to `create` / `openChat` is installed before the turn;
`ensureSkillInstalled(workspaceRoot, id)` installs one ahead of time and never
throws.

## Accepting drags from the Backlog and Files panels

`readFileDropPayload(dataTransfer)` reads the published payload under
`SPRINTENGINE_FILE_DROP_MIME` and returns `null` — never throws — for anything
it does not recognise. `hasFileDropData` is the `dragover`-safe presence check;
`setFileDropData` originates a drag the app's own drop targets accept.

## Theme tokens

`THEME_TOKENS` lists the CSS custom properties present in every app theme.
Use them as CSS variables (`var(--bg-surface)`); only the names are contract.

| Family | Tokens |
|---|---|
| Chrome | `--bg-app`, `--bg-surface`, `--bg-surface-raised`, `--bg-hover`, `--bg-selected` |
| Border | `--border-subtle`, `--border-default`, `--border-strong` |
| Text | `--text-strong`, `--text-default`, `--text-muted`, `--text-subtle`, `--text-disabled`, `--text-on-accent` |
| Accent | `--accent-primary`, `--accent-primary-soft`, `--focus-ring` |
| Tone | `--tone-neutral`, `--tone-accent`, `--tone-warn`, `--tone-good`, `--tone-error`, `--tone-merged` |
| Motion | `--motion-normal`, `--motion-ease` (use as a pair) |

## UI kit, surface shell and Monaco

| Specifier | What it is |
|---|---|
| `@sprintengine/module-sdk/ui` | A curated slice of the app's component kit |
| `@sprintengine/module-sdk/surface` | The door shell and its rail/canvas substrate |
| `@monaco-editor/react` | The Monaco wrapper the app ships |

These are **host-provided**: this package ships their types, and the `.js`
behind `./ui` and `./surface` throws if evaluated. The app answers them (and
`react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`) from an import
map, so mark every one external:

```
esbuild src/renderer.tsx --bundle --format=esm --outfile=module/dist/renderer.mjs \
  --external:react --external:react-dom --external:react-dom/client \
  --external:react/jsx-runtime --external:@monaco-editor/react \
  --external:@sprintengine/module-sdk/ui --external:@sprintengine/module-sdk/surface
```

`/ui`: `GhostButton`, `OutlineButton`, `PrimaryButton`, `Banner`,
`PanelHeader`, `Drawer`, `EmptyState`, `Field`, `Input`, `Textarea`,
`InlineNotice`, `KbdChord`, `LifecycleGlyph`, `LinkButton`, `RowButton`,
`Section`, `SegmentedControl`, `Select`, `Spinner`, `StatusDot`,
`TruncatedText`, `CliModelPickerButton`, `FOCUS_RING_CLASS`, and their props.
`/surface`: `GlobalSurfaceShell`, `useSurfaceBackNav`, `SurfaceRail`,
`SurfaceCanvasState`, and their props.

**Tailwind classes you write produce no CSS** — the app's build scans app
source only. Write plain CSS against the theme tokens, or build a
stylesheet of your own and inject it once when your renderer registers (the
`panel` template's `src/styles.ts` does this).

## Signing and packaging

```sh
npx sprintengine-module keygen --out ~/.sprintengine/keys/my-extension.key   # once; keep it out of the project
npx sprintengine-module sign module --key ~/.sprintengine/keys/my-extension.key
npx sprintengine-module verify module
npx sprintengine-module pack module --out dist/my-extension
```

`sign` validates the manifest, records the sha256 of every file the module
ships in `files`, and signs the normalized manifest. `verify` checks the
signature and every file against `files`. `pack` copies an installable module,
leaving out `node_modules`, `.git` and key files. Sign again after every build.

**`files`** maps each file's POSIX path (relative to the module root) to its
lowercase sha256, for every file except `manifest.json`; a changed, missing or
extra file is a mismatch. It is part of the signed payload, so a signature
covers the code. A module whose manifest has no `files` does not load at all —
signed or not — and `npm run dev:install` writes it for an unsigned local
build. The checks are exported for tooling: `validateModuleFileDigests`,
`compareModuleFileDigests` (root, pure); `computeModuleFileDigestsSync`,
`moduleFileDigestIssuesSync` (`@sprintengine/module-sdk/signing`, Node).

For a bundle, `sprintengine-module plugin sign <dir> --key …` writes each
component's digests into `plugin.json` and signs it; sign the module first,
since signing rewrites its manifest. `plugin scaffold`, `plugin verify` and
`plugin pack` round it out. Bundle components are `mcp`, `skills` and
`module`.

## Installing

- **On your machine:** `npm run dev:install` builds, writes `files`, signs when
  a key is at `~/.sprintengine/keys/<id>.key`, and copies `module/` into
  `~/.sprintengine/modules/<id>/`. Studio asks you to trust it (again after each
  rebuild, since trust binds to exact contents). **Settings → Modules → Install
  a module from a folder** does the same for a packed folder.
- **From GitHub:** anyone can install from the repository URL (the Extensions
  door's **Install extension from GitHub…**). Studio resolves the default branch
  to a commit, reads **`plugin.json` at the repository root**, shows its name,
  publisher, permissions and whether it is signed, and installs the `module/`
  folder it names. Commit `module/dist/` and the `module/manifest.json` its build
  produced (with `files`). An **unsigned** module is allowed: Studio warns that
  nobody vouches for the code and requires an explicit "I trust this code"
  choice. An update re-checks the commit and asks again when the permissions
  or the signing change. A repository with `.claude-plugin/` is a skill source,
  added from the Skills path instead.
- **From the marketplace:** a signed bundle listed in the registry; see
  [`docs/plugin-authors/README.md`](../../docs/plugin-authors/README.md) in the
  app repository.

## Packaged web runtimes and WebAssembly

`host.getAssetUrl('runtime/index.html')` returns a stable `studio-module:` URL
for a file in the installed module — use it as an iframe `src`. Relative
scripts, workers, WebAssembly (`application/wasm`) and IndexedDB work inside
it, under a private per-installation origin. The host checks trust and
enablement on every request and serves only files the module was verified
with, up to 128 MiB. Never store secrets in the module folder or log these
URLs; use the secrets broker. This is not a sandbox for hostile code.

## Opening a zero-config workspace

A folderless workspace type can set `openOnFirstLoad: true`: once the module is
trusted and enabled, the primary window creates a workspace from
`createTemplate()` (or opens the existing one) the first time, and never again
on its own. `host.openWorkspace(typeId)` reopens it from a command; it accepts
only your own types without a `creationStep` or `createWorkspace` hook.

A new renderer-only module loads as soon as it is trusted. A module with
`entry.main`, or an update to code already loaded, takes a restart.

## Intentional narrowings

The drift guard keeps these narrowings sound — an SDK-typed module is always
valid for the app:

- `WorkspacePanelProps` exposes `workspaceId` only.
- `deriveRunGlyph` receives `{ mode }` and returns the published
  `WorkspaceRunGlyphState` subset.
- `WorkspaceLayoutJson` is a conservative subset of the app's layout model.
- `BacklogItemView` widens enumerated app internals to `string`.
- `BacklogItemActionContext` and `FileActionContext` omit shell-internal hooks.
- `NotificationActionContext.notification` is `{ workspaceId?, navigationTarget? }`.
- `CompanionAgentEvent.type` is widened to `string`.

## Versioning

Semver; `1.0.0-beta.0` is the first release of this contract (see
`CHANGELOG.md`). The package version and the host API version move
separately: a new SDK release that only adds optional types keeps
`HOST_API_VERSION`, and a module declares the host API, not the package
version. In the app repository a drift guard (`drift/sdk-drift-guard.ts`,
`npm run test:sdk:drift`) fails the build whenever these declarations diverge
from the app's own contracts, and `npm run test:sdk:pack` imports every
published name from the packed tarball.

## License

MIT — see [`LICENSE`](./LICENSE). You may build extensions against this SDK and
distribute or sell them, including closed-source. Marketplace distribution is
covered by separate marketplace terms.
