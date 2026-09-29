# Pitfalls

Each of these cost an earlier extension (Reviews, Calendar, Doom) real time.

## Build and load

**Tailwind utilities you write compile to nothing.** Studio's CSS is generated
from Studio's own source; a `flex gap-2` first used in your module has no rule
behind it and renders as unstyled markup — or, worse, looks right because the
app happens to use the class too, and breaks when it stops. Use the UI kit,
inline styles and plain CSS on theme tokens, or compile a utilities-only
stylesheet of your own and inject it once ([ui-kit.md](ui-kit.md)).

**The renderer bundle has one shape.** One ESM file, with exactly these
external: `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`,
`@monaco-editor/react`, `@sprintengine/module-sdk/ui`,
`@sprintengine/module-sdk/surface`. The host answers only those. The SDK root
(`@sprintengine/module-sdk`) must be bundled in, not external — nothing
answers that bare specifier at runtime. Code splitting and dynamic `import()`
of your own chunks do not work: there is one file.

**The main bundle is CommonJS with only `electron` external.** The installed
module folder has no `node_modules`; anything left external is missing at
load. `react` has no business in `entry.main`.

**The renderer bundle runs from a blob URL.** `new URL('./x.png', import.meta.url)`,
relative `fetch`, a relative `<img src>` all resolve to nothing. Package the
file in `module/` and use `host.getAssetUrl('assets/x.png')`. For HTML/WASM
runtimes, point an iframe at `host.getAssetUrl('runtime/index.html')`; inside
it, relative URLs work.

**Only renderer-only modules start without a restart**, and only the first
time. A module with `entry.main`, or new code for a module Studio already
evaluated in this session, needs a restart. Tell the person which.

**Registration must finish.** A throw, a rejected promise, or more than 10
seconds in `registerRenderer`/`registerMain` is a load error. Do slow work
lazily, in a handler or an effect.

## Trust and signing

**Any change under `module/` voids trust.** Trust is granted to the manifest's
fingerprint, which covers `files`, which covers every byte in `module/`. After
each rebuild: `npm run dev:install`, then trust again in Settings → Modules.

**A signed module changed after signing is refused, not just untrusted.** Sign
again after every build you install or publish (`dev:install` does when your
key exists). If you have no key, `dev:install` drops a stale signature and
installs unsigned.

**No `files`, no load.** Studio holds an installed module to its manifest's
`files` digests; a module without them cannot be trusted. `dev:install` and
`sprintengine-module sign` write them — do not hand-edit.

**Keys never live in the project.** `~/.sprintengine/keys/<id>.key`, mode 600.
One sibling project kept `calendar-signing.key` in its root; the validators
now fail on that.

**Reserved ids.** `review`, `automations`, `backlog` and the rest of
`BUNDLED_MODULE_IDS` are claimed by Studio; a module using one is refused.

## Data

**Use the host's storage.** `getModuleStorage` (main), module app state and
workspace module state (renderer). Hand-rolled JSON in `~/.something` is an
undisclosed home-folder write, is not cleaned up on uninstall, and breaks with
several windows open.

**Resolve workspaces through the host.** `host.getWorkspace(id)` /
`WorkspaceContextToken` give `folderPath`; do not derive a root from Backlog
paths or drag payloads. `null` means "not yet" — retry, never delete state.

**Events are signals.** `host.emit` is not replayed; a window opened later
missed everything. Keep the truth readable through an IPC channel.

## Look and feel

**Tokens only, and tones are flat.** No hex. A soft tone fill is
`color-mix(in srgb, var(--tone-accent) 15%, transparent)`.

**No status dots.** Studio draws states as words, lifecycle glyphs, timers or
its working mark. A little coloured circle is not one of them.

**The top bar is dense.** One compact control. A cluster belongs in a door.

**A panel appears only in a layout.** `registerPanel` alone shows nothing;
place it with a workspace type's `createTemplate`.

**A sidebar nav entry cannot open a surface.** For a door people can open,
give `registerGlobalSurface` a `label` and an `Icon`: the Extensions drawer
lists it.

## Agents and untrusted input

**Agents are chats.** `getConversationService` / `openChat`. There is no
terminal-agent API, and spawning an agent CLI yourself from `entry.main`
bypasses the person's runtime choice, approvals and visibility.

**Agent output, PR diffs, issue bodies and web pages are untrusted input.**
They can contain instructions aimed at an agent or at your code. Render them
as text (never `dangerouslySetInnerHTML`), never `eval` them, and check any
path, URL or command they name against what your module allows before acting.
When you feed such content to an agent, say in the prompt that it is data to
analyse, not instructions.

**Draft by default.** `openChat` without `send: true` lets the person read the
prompt before anything runs. `permissionPreset: 'bypass'` only when they asked.

**Permissions are disclosure.** The host checks some, not all; it does not
sandbox your code. The prompt is a promise to the person: keep it true.
