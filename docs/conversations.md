# Conversations

Chat agents run through the conversation runtime; terminal agents keep their
existing PTY workflow. The launcher lists these surfaces separately. A provider
only exposes the controls it actually supports: models, reasoning effort, image
input, skills, plans, questions, interruption, and permission presets.

## Local workflow

Start a chat in a workspace, choose an installed provider and model, and send a
prompt. Tool activity stays in the transcript with expandable input/output and
file links. Older turns page in as needed; search can open a historical turn.
Selecting a skill adds persistent context, while file mentions attach to one
send. Failed sends keep the draft. Pending approvals and questions appear above
the composer, with a counter and keyboard navigation when several are waiting.

Remembered tool permissions are scoped to the conversation or workspace.
Requests that cannot be represented safely as a rule offer only a one-time
decision. Deny-by-default requests focus Deny. Workspace rules can be reviewed
and revoked. Remote clients cannot choose a permanent rule.

Every chat has one of two permission presets, the same two a terminal agent
has: **Bypass permissions** (Codex: **YOLO**), the default, which starts the
CLI with its own skip-every-prompt setting, and **No flag**, which passes no
permission setting at all, so the CLI runs on its own configured default. An
organization that does not allow bypass chooses No flag. Plan mode is a
separate toggle, not a preset. Under No flag the CLI can still ask, and its
requests appear as approval cards.

Every surface that starts an agent takes both presets (owner ruling
2026-09-27): the launcher, a launch on a paired machine, the automation and MCP
tools (`agent.launch`, `backlog.work`, `automation.create`,
`conversation.create`), and automations themselves. A launch that names no preset resolves the way the
launcher does: the preset chosen for that CLI on the machine that runs it, else
Bypass. The launcher names its preset when it starts an agent on a paired
machine, so the agent there runs on the choice the launcher showed.

Completed turns may expose changed files and a checkpoint diff. Reverting asks
for confirmation and refuses when the working tree no longer matches the
checkpoint's expected content. Checkpoints preserve the real Git index and do
not include submodules.

## Installed CLI providers

Claude and Codex use their native headless interfaces. ACP providers share an
adapter and declare profile-specific capabilities. The user's installed CLI
and native credentials remain authoritative; Studio does not bundle these ACP
executables or copy credentials to a remote client.

Bypass reaches each CLI its own way: Claude through the SDK's
`bypassPermissions` mode, Codex as `approvalPolicy: never` with full-access
sandboxing, Cursor as `--force`, Grok as `--always-approve`, and OpenCode as an
`OPENCODE_PERMISSION` rule set that allows everything, since `opencode acp`
takes no permission flag. No flag sends none of these. Do not interpret a hidden
approval control as a promise that a provider will ask for permission.

A Claude chat loads only the person's user settings, never the project's, so
the app's MCP gateway is handed to each Claude chat directly rather than read
from the workspace's `.mcp.json`. An automation that runs with a connector
starts its chat with that connector's MCP server the same way: Claude through
the SDK's `mcpServers`, Codex as `mcp_servers` config overrides for that chat's
app-server, and ACP agents through `session/new` (HTTP and SSE servers only
where the agent's handshake says it takes them). A provider that cannot take
the server fails the run and says so, rather than running without it.

ACP filesystem callbacks are confined, verified existing-file operations.
Creating a new file through those callbacks is refused on platforms without
anchored directory operations; provider-owned native edits are a separate CLI
capability. Post-open filesystem checks are defense in depth, not a kernel
sandbox against a malicious process repeatedly replacing directory ancestors.

## Remote connection over the tailnet

Another machine follows and drives a conversation over Tailscale, and only over
Tailscale: there is no hosted relay in the path, for transcripts, commands,
images or phase changes. The phone companion and another Studio desktop use the
same socket and the same frames; nothing in the wire is specific to a phone.

### Trust boundaries

- **Network.** The gateway listens only on this machine's tailnet address
  (loopback in tests). Tailscale authenticates the peer machine; the gateway
  records the peer node it resolved, but does not treat it as authorization.
- **Device.** Authorization is the paired device's bearer token and its scopes.
  A WebSocket is opened with a short-lived single-use ticket, never the token in
  a URL. Browser-originated requests are refused.
- **Scopes.** `conversation:read` lists, follows and pages conversations and
  fetches tool details and diffs. `conversation:operate` sends, stops, answers
  approvals and questions, attaches images, changes the permission preset and
  switches the model, and implies read. New pairings grant both by default; the pairing surfaces
  list them as their own rows. There is no terminal scope: terminals do not
  cross the tailnet (see "Terminals stay on the machine" below).
  Grants are read live: narrowing a device in Settings refuses its next
  command, removing read closes its socket (4403), and revoking it closes every
  stream it holds (4401).
- **What a remote command can do.** A device with `conversation:operate` drives
  a chat exactly as the host can, preset included: it can send to a chat in
  Bypass, and switch a chat between Bypass and No flag. A conversation a remote
  send resumes starts under the preset it was left on. The one thing a remote
  command cannot choose is a permanent approval rule, which outlives the
  conversation; that is refused before the runtime sees it.
- **Starting a chat.** The same grant starts one: `conversation.create` adds a
  chat agent to one of this machine's workspaces, starts its session on the
  named CLI (the launcher's model and preset, else this machine's choice for
  that CLI), and sends the prompt as its first message. It answers once the
  session is up, with the workspace and agent ids a remote pane follows the
  chat by. Like every remote command it is audited.
- **Switching a chat's model.** A desktop that advertises the
  `conversation-models` capability (owner ruling 2026-09-27) lists each chat's
  CLI and the models this machine's own picker offers for it — the CLI's
  reported catalog (its manifest seed until it has reported) and the ids added
  in Settings — and takes a `setModel` command naming one of them, or the CLI's
  own default. The switch stays within the chat's CLI: an id outside the
  catalog is refused with `unsupported_model` before the runtime sees it, and
  a provider that binds a session to its model refuses it as well. The switch
  runs through the same runtime path as a switch made here, a chat with no live
  session is resumed to take it, and a switch made while a turn is running is
  accepted with a notice that the new model applies from the next turn. This
  machine's own chat view follows a switch made from a paired device.
- **Audit.** Every remote command — refused ones included — is written to the
  gateway audit with the device, the conversation, the command kind, the command
  id and the outcome. Message text and answers are never written there.
- **What leaves the machine.** Frames carry transcripts, tool output previews,
  tool details and diffs, with secret-looking keys redacted. Paths in the
  followed conversation's workspace are sent workspace-relative; other paths in
  the home directory start `[home]`.
- **Images.** Uploads are staged in a private temporary directory, never in the
  workspace, and referenced by an opaque id bound to the device and session.
  At most 16 images of 5 MB each per turn, as JPEG, PNG, GIF or WebP, on a live
  image-capable session. An accepted send removes its staged files; unused ones
  expire after an hour.
- **Pictures a step shows.** A desktop that advertises the `conversation-images`
  capability serves the picture a step made (Codex's `GenerateImage`) or looked
  at (a file read of a picture) at `GET /tailnet/v1/conversation-image`, named
  by `workspaceId`, `agentId` and the step's `toolUseId`, to a device with
  `conversation:read`. The file is the one the conversation's own record of
  that step names — the request carries no path — followed through links to a
  regular file, and served only when its first bytes are a PNG, JPEG, WebP or
  GIF (`415 not_an_image` otherwise, whatever its name) and it is at most 8 MB,
  the ceiling this machine's own previews use (`413 image_too_large`). A chat
  this machine does not have is `404 unknown_conversation`; a step that is not
  there, shows no picture, or whose file is gone is `404 unknown_image`. The
  bytes are cached privately for a day, since a step's picture never changes.
  A paired desktop shows these under a remote chat's steps the same way; for a
  machine without the capability it still says the picture is on the other
  machine.

### Sync

A subscription receives its replay — a bounded snapshot, or only the missed
events — then a `synchronized` fence, then live events. A client resumes with
the last sequence it holds and the log `generation` from the snapshot or fence
it came from; when the desktop can vouch for that cursor it sends only the
missed events and no snapshot. Another generation (the log was recreated), a
cursor ahead of the log, or one too far behind gets a reset snapshot instead.
Sequence numbers increase but have gaps, because a run of text deltas can be
merged into one delta numbered with its last sequence. Older turns page in
through `loadEarlier`. Command ids stay stable across retries, so a send
acknowledged before a disconnect is not accepted twice.

A reader that falls behind gets consecutive deltas merged instead of queued;
a large snapshot is sent in parts and never counts against live events. A
reader that stops reading is told to resync with a retry delay that grows while
it keeps falling behind. Requests beyond the per-socket bound are answered
`busy`, and responses over 32 MB are answered `too_large`; neither closes the
socket. Every refusal is answered under the id of what it refuses.

Every snapshot and fence names the conversation it belongs to. When a socket
switches conversations, the old replay stops at the next whole frame and never
sends its fence, and a client ignores frames for a conversation it no longer
follows. Live events that arrive while a replay is still going out wait behind
it, bounded by size rather than count, so a busy turn during a large catch-up
does not force a resync before the fence.

The portable protocol lives in `packages/conversation-protocol`; its README is
the frame reference. Its source mirror and digest in the companion must be
updated together until the companion adopts a published package version.
Building this branch does not publish that package.

Phase changes reach a client while its socket is open, and every paired
device's change feed says when the conversation list moved — a conversation
started, finished, or began waiting on a person — so a list re-reads on the
change rather than on a timer. Background push notifications are not provided. A conversation deep link is
`sprintengine://conversation/<deviceId>/<workspaceId>/<agentId>` (each component
URL-encoded); it resolves only against an already paired desktop.

### Following from another desktop

A Studio desktop paired to this one follows its conversations with the same
pairing and grant a phone uses. The sidebar's
Remote band lists each chat on the paired machine as its own row, with the
presence its phase says: running, needs approval, or done. Opening one makes a
solo workspace whose pane is the regular chat view, following the conversation
over the tailnet, with the machine on the tab and above the transcript.
New chat starts one there too: with Chat agent picked, the machine dropdown
offers the paired machines, and launching on one asks it to start the chat in
the chosen project and opens that same pane on it. Skills and attached images
are this machine's and do not travel yet; the launcher says so rather than
dropping them. A WSL distribution is still not offered for a chat, which runs
in the app's own process.

- **The copy is kept.** Main follows over one socket per conversation, shared
  by every window showing it, and keeps the transcript tail with its cursor
  (log generation and last sequence) in the app profile. A dropped link or an
  app restart shows the conversation at once and asks only for what came after
  the cursor; another generation, or a cursor too far behind, gets a reset
  snapshot that replaces the copy. Forgetting the machine deletes its copies.
- **Every frame is validated** against the protocol before it touches the copy.
  A frame of a known type in the wrong shape ends the follow with a sentence
  rather than being skipped, since skipping an event and moving the cursor past
  it would lose it.
- **The link follows the host's advice.** A resync close waits the delay it
  names, a wake does not cut that short, `busy` is retried after its delay under
  the same id, a revoked device or a lost read grant ends the follow without
  retrying, and a socket silent past two of the host's pings is re-dialled.
- **What the view offers is what the grant and the lane allow.** A pairing
  without `conversation:operate` sees the conversation with the composer,
  approvals and stop closed. A remote view never offers a permanent approval
  rule, a checkpoint revert, or this machine's skills, files and images. It
  offers the same two-preset switcher a local chat does, reading the preset the
  machine's list names; a desktop built before the list carried the preset
  leaves the switcher hidden rather than guessing. Its engine chip is the same
  picker a local chat has, locked to the chat's CLI and listing the models the
  machine's own catalog names; a machine that does not advertise
  `conversation-models` keeps the chip on the model the chat is on. File paths in a
  remote transcript are not links, since they name files on the other disk. A
  send is answered when its turn ends, as on the desktop itself, and a send in
  flight across a reconnect is sent again under the same command id and
  accepted once.

### Terminals stay on the machine

Conversations are the only agents that cross the tailnet (2026-09-29). A
paired device, phone or desktop, cannot list, watch, type into, or start a
terminal on this machine: there is no terminal socket and no terminal scope,
and the tools that list terminals or start an agent in one (`terminal.list`,
`terminal.create`, `agent.launch`, `backlog.work`, `automation.run`) are served
on the local socket only, to the agents and MCP clients on this machine. What a
paired device starts is a chat, through `conversation.create`, and the machine
dropdown in New chat offers a paired machine only for a Chat agent. Automations
stay on the machine too: the phone neither lists nor runs them, and the
desktop's own Automations surface and the local `automation.*` tools are
unchanged. A tab left open on a remote terminal by an earlier build reopens as
an unavailable panel.

## Manual verification

1. Run `npm run verify:app` and `npm run build`, then start Studio with a separate
   development profile.
2. Start an installed chat provider, stream a reply, expand work groups, select
   code while it streams, and scroll back while new text arrives.
3. Attach a skill and a file, switch conversations, and confirm the draft and
   skill survive. Deny a request, answer a multi-question prompt, and interrupt
   a running turn.
4. Open an old search result, close/reopen the conversation, inspect changed
   files, and check a confirmed revert in a disposable repository.
5. Pair the companion over a tailnet with conversation access. Read, send,
   approve, answer, stop, disconnect mid-reply and reconnect (the reply resumes
   without a reset), and verify an offline send appears once after
   acknowledgement. Narrow the device to read-only in Settings and confirm the
   next command is refused.
6. Pair a second Studio desktop with conversation access. Open a chat from its
   Remote band, send, approve and stop from there; switch its model between
   turns and mid-reply (the notice says the switch applies from the next
   turn), and confirm the host's own chip follows; drop Wi-Fi mid-reply and
   rejoin (no reset, no repeated text); quit and relaunch it (the transcript is
   on screen before it reconnects, then catches up). Narrow the pairing to read
   and confirm the composer closes with the reason.

Mocked native UI fixtures and protocol tests do not replace a live provider or
physical-device test. Authentication-dependent checks should record which CLI
and permission policy were actually exercised.
