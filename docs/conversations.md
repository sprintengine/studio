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
  approvals and questions, attaches images and changes the permission preset,
  and implies read. New pairings grant both by default; the pairing surfaces
  list them as their own rows. The terminal tier does not grant either.
  Grants are read live: narrowing a device in Settings refuses its next
  command, removing read closes its socket (4403), and revoking it closes every
  stream it holds (4401).
- **What a remote command can do.** A device with `conversation:operate` drives
  a chat exactly as the host can, preset included: it can send to a chat in
  Bypass, and switch a chat between Bypass and No flag. A conversation a remote
  send resumes starts under the preset it was left on. The one thing a remote
  command cannot choose is a permanent approval rule, which outlives the
  conversation; that is refused before the runtime sees it.
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

A Studio desktop paired to this one follows its conversations the way it
attaches to its terminals, with the same pairing and grant. The sidebar's
Remote band lists each chat on the paired machine as its own row, with the
presence its phase says: running, needs approval, or done. Opening one makes a
solo workspace whose pane is the regular chat view, following the conversation
over the tailnet, with the machine on the tab and above the transcript.

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
  rule, a checkpoint revert, a model switch, or this machine's skills, files and
  images. It offers the same two-preset switcher a local chat does, reading the
  preset the machine's list names; a desktop built before the list carried the
  preset leaves the switcher hidden rather than guessing. File paths in a
  remote transcript are not links, since they name files on the other disk. A
  send is answered when its turn ends, as on the desktop itself, and a send in
  flight across a reconnect is sent again under the same command id and
  accepted once.

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
   Remote band, send, approve and stop from there; drop Wi-Fi mid-reply and
   rejoin (no reset, no repeated text); quit and relaunch it (the transcript is
   on screen before it reconnects, then catches up). Narrow the pairing to read
   and confirm the composer closes with the reason.

Mocked native UI fixtures and protocol tests do not replace a live provider or
physical-device test. Authentication-dependent checks should record which CLI
and permission policy were actually exercised.
