# Launch settings ownership

Who owns the settings an agent launch is composed from, how a window reads
and changes them, and how a profile from before this arrangement was carried
over.

The settings in question are five fields, one record:

- `cliRuntimes` — each agent CLI's command, its WSL switch and the model ids
  the person added to it;
- `mcp` — the MCP config sync switch and the installed servers;
- `projectKnowledgeRoots` — the knowledge folder per project;
- `lastSelectedCli` — the CLI a spawn runs on when the caller names none;
- `lastAgentSpawnPermissionPreset` — the permission preset a spawn defaults
  to.

The shapes and the patch rules are in `src/shared/launch-settings.ts`.

## Main is the single owner

Main holds the one authoritative record, in `agent-launch-settings.json` under
userData (`src/main/launch-settings-store.ts`). The file name is the one the
earlier mirror used, so an existing profile keeps its record. Writes are
atomic (temporary file, then rename), queued behind one another, and carry a
monotonic revision and the process boundary they came through. A write that
changes nothing is not a revision: no bump, no file write, no broadcast.

Everything in main that composes a launch reads the record synchronously
through `get()`: the agent-launch service, the terminal runtime's spawn
permission default, and the model discovery pass main starts on its own at
boot or after an install. None of them needs a window to be open.

Windows do not author these settings any more. The store's
`appSettings.cliRuntimes`, `mcp`, `projectKnowledgeRoots`, `lastSelectedCli`
and `lastAgentSpawnPermissionPreset` are a read model of main's record
(`src/renderer/src/store/launchSettingsClient.ts`), and they are not persisted
to localStorage.

Before this change the renderer authored the five fields in localStorage and
pushed the whole record to main on every change, and main kept a copy. Two
windows could each push a stale copy of the other's edit, and a headless
launch only saw what the last window to open had pushed.

## Channels

| Channel | Direction | What it carries |
| --- | --- | --- |
| `launch-settings:get` | window → main | The record (null before any write) and the settings in force, which is what a window shows at boot. |
| `launch-settings:update` | window → main | A partial patch. Answered with the record main now holds. |
| `launch-settings:migrate` | window → main | The one-time handover described below. Answered with main's record either way. |
| `launch-settings:changed` | main → every window | The new record, after every write that changed it, whoever made it. |

A patch names only what it changes. A CLI's runtime is replaced whole and the
other CLIs are untouched; the MCP switch and each server are separate fields,
so adding one server does not rewrite the rest; each knowledge root is its own
key. `null` removes an entry, or returns a scalar to "never chosen".

## How a window uses them

At boot the window subscribes to `changed` first, so nothing is missed, then
reads the record with `get`. The workspace window does not render until that
read has finished (bounded by the same three-second limit as the third-party
module boot), so no picker shows a CLI or a preset the person never chose.

Every existing setter keeps its signature. It applies the change to the store
at once, so a control does not lag, and sends main the patch for the part it
changed. What the store ends up holding is main's answer:

- a record is adopted only when its revision is newer than the last one the
  window adopted, so a late echo cannot undo a newer value;
- while the window has an update in flight nothing is adopted; when the last
  one settles, the newest record seen is, which also reverts an optimistic
  change main refused or never received.

A record is read into `appSettings` through the same normalizers a hydration
uses, so a never-chosen CLI or preset reads as the app default and the
default runtimes are filled in, exactly as before.

## The migration

A profile from before this change has the five fields in its localStorage
settings envelope, and may or may not have a record in main (the earlier
mirror wrote one whenever a window pushed).

On hydration the window reads the five fields out of the envelope once, as a
migration offer, and otherwise ignores them. At boot:

1. If main answers `get` with a record, main's values win and nothing is
   offered.
2. If main has no record and the envelope had the fields, the window offers
   them through `migrate`. Main accepts only while it holds no record, so the
   first window to offer seeds the record and every later offer — a second
   window booting at the same moment, the same window next time — is refused
   and answered with main's record, which the window adopts.
3. Once main has answered with a record, by either path, the window strips
   the five fields from its localStorage envelope and never writes them again.

Updates a window issues before its boot has finished wait for it, so a setter
cannot create main's record ahead of the offer and get the offer refused.

If main does not answer at all, the window shows its own old values and keeps
them in the envelope, and the next boot offers them again. Nothing is lost on
a boot where main is unreachable.

An old file that held bare settings with no revision still reads; a migration
replaces it, and an update is applied on top of it so its other fields carry
forward.

A backup restore after a wiped localStorage brings back the fields this window
owns (recent folders, sidebar state and the rest) but not the launch settings:
those were never in localStorage's care and main's file still has them.
