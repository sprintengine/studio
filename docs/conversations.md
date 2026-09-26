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
and revoked. Remote clients cannot choose a permanent rule or a bypass preset.

Completed turns may expose changed files and a checkpoint diff. Reverting asks
for confirmation and refuses when the working tree no longer matches the
checkpoint's expected content. Checkpoints preserve the real Git index and do
not include submodules.

## Installed CLI providers

Claude and Codex use their native headless interfaces. ACP providers share an
adapter and declare profile-specific capabilities. The user's installed CLI
and native credentials remain authoritative; Studio does not bundle these ACP
executables or copy credentials to a remote client.

OpenCode supports an explicit manual approval policy. Cursor's current ACP
profile uses CLI-managed permissions and rejects unsupported manual policies.
Do not interpret a hidden approval control as a promise that a provider will
ask for permission. The launcher and permission selector identify the available
policy explicitly.

ACP filesystem callbacks are confined, verified existing-file operations.
Creating a new file through those callbacks is refused on platforms without
anchored directory operations; provider-owned native edits are a separate CLI
capability. Post-open filesystem checks are defense in depth, not a kernel
sandbox against a malicious process repeatedly replacing directory ancestors.

## Phone connection

The companion connects directly to the paired desktop over the tailnet. The
gateway advertises the additive `conversations` capability and separate
`conversation:read` and `conversation:operate` grants. Older clients and the
existing mobile-control wire continue independently. Re-pair when the existing
device grant does not include conversation access.

Transcripts, tool output, images, and diffs do not pass through the hosted relay.
Images require a live image-capable session; the gateway accepts at most 16
images of 5 MB each per turn, with JPEG, PNG, GIF, and WebP media types. Upload
references are device/session scoped and expire. A remote send refuses an
unsafe desktop permission preset rather than silently changing that preset.

The portable protocol lives in `packages/conversation-protocol`. Its source
mirror and digest in the companion must be updated together until the companion
adopts a published package version. Building this branch does not publish that
package.

Phone notification delivery is not provided by the conversation socket. It
requires a separate hosted notification service, push credentials, and a mobile
notification integration. A conversation deep link is
`sprintengine://conversation/<deviceId>/<workspaceId>/<agentId>` (each component
URL-encoded); it resolves only against an already paired desktop.

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
   approve, answer, stop, disconnect/reconnect, and verify an offline send
   appears once after acknowledgement.

Mocked native UI fixtures and protocol tests do not replace a live provider or
physical-device test. Authentication-dependent checks should record which CLI
and permission policy were actually exercised.
