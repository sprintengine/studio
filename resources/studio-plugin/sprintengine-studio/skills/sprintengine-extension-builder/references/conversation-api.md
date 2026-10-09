# Chats: the conversation service and openChat

Studio runs agents as chats on the agent runtimes installed on the machine
(Claude Code, Codex, and the rest). An extension works with agents in two
ways, and only these two:

| | Where | Permission | Who sends |
| --- | --- | --- | --- |
| `host.openChat(input)` | renderer | `conversation:operate` | The person: the prompt lands as a draft unless `send: true` |
| `getConversationService(host)` | main | `conversation:operate` (everything) or `conversation:read` (watch/read only) | The module |

Both create ordinary chats: a tab in the workspace the person can read, answer
and stop. A module drives only chats it created — never the person's own, never
another module's (`not_owned`). Reading the person's chats, read-only, is
`getActivityService(host)` behind the broad `conversation:read-all`
([api-main.md](api-main.md)). There is no terminal-agent API; do not spawn
agent CLIs from `entry.main` to work around that.

Check `host.supports('conversations')` (main) or `host.supports('chat.open')`
(renderer) first, and tell the person when the host does not offer it.
`host.supports('conversation-controls')` says the host also takes the four
presets, `setPermissionPreset`, `setModel` and approval `decision`s;
`conversation-streams` says it takes `follow` and `commandId`;
`conversation-requests`, `answerQuestion` and `resolvePlan`; and
`conversation-permissions`, `permissionMode` and `allowedTools`.

## openChat (renderer)

```ts
const opened = await host.openChat({
  workspaceId,                       // required; a workspace with a folder
  prompt: 'Plan the change described in docs/plan.md.',
  skills: ['my-skill'],              // optional: installed and invoked in the first turn
  cli: 'codex', model: undefined,    // optional; absent = the runtime the person last chose
  send: false,                       // default: a draft
})
if (!opened.ok) showError(opened.message)  // permission_missing | unknown_workspace | workspace_folder_missing | cli_not_conversational | unavailable
else host.focusTab({ workspaceId, kind: 'chat', id: opened.agentId })  // openChat already focuses; this re-focuses later
```

Prefer the draft. A prompt the person reads before it runs is a prompt they
agreed to. `listChatRuntimes()` lists `{ id, label, available, models,
lastSelected }` for a picker of your own.

## The conversation service (main)

```ts
import { getConversationService, type RegisterMain } from '@sprintengine/module-sdk'

export const registerMain: RegisterMain = (host) => {
  if (!host.supports('conversations')) return
  const chats = getConversationService(host)          // manifest: "dependsOn": ["agent-runtime"]

  host.registerIpc(`${host.moduleId}:start`, async (_event, input) => {
    const started = await chats.create({
      workspaceId: String((input as { workspaceId?: unknown }).workspaceId),
      name: 'Release notes',
      prompt: 'Draft release notes from the commits since the last tag. Do not push.',
      // cli, model, skills, attachments, permissionPreset: optional
    })
    if (!started.ok) return started                     // { ok: false, code, message }
    const ref = { workspaceId: started.conversation.workspaceId, agentId: started.conversation.agentId }
    const off = chats.subscribe(ref, (event) => {
      if (event.type === 'turn_completed') { off(); host.notify({ severity: 'info', title: 'Release notes drafted' }) }
    })
    return started
  })
}
```

| Method | Needs | Notes |
| --- | --- | --- |
| `create({ workspaceId, prompt?, name?, cli?, model?, skills?, attachments?, permissionPreset?, permissionMode?, allowedTools?, commandId? })` | operate | Resolves `{ ok: true, conversation }` once the chat exists. `prompt` is sent as the first turn. `permissionPreset` (`manual`, `none`, `auto`, `bypass`) absent = the person's default; `'bypass'` skips the runtime's approval prompts — only when the person asked for it, and only with `conversation:bypass` declared (otherwise it runs on `auto`). `permissionMode` is the CLI's own mode at that preset. `allowedTools` are used without asking and need `conversation:bypass`. |
| `send(ref, { message, skills?, attachments?, steer? })` | operate | Another turn. `steer: true` lands it inside the turn that is running. |
| `interrupt(ref)` / `stop(ref)` | operate | Stop the current turn / end the session. |
| `respondToApproval(ref, { requestId, decision, answers?, commandId? })` | operate | Answer an `approval_requested` event: `decision` is `once`, `conversation` (that kind of request, for the rest of the chat) or `deny`; the older `approved: boolean` still works. Approve only what the person would approve. |
| `answerQuestion(ref, { requestId, answers, commandId? })` | operate | Answer a request of kind `question`: question text to the chosen answer. Refused for any other kind. |
| `resolvePlan(ref, { requestId, decision, commandId? })` | operate | Answer a request of kind `plan`: `approve` or `reject`. Refused for any other kind. |
| `setPermissionPreset(ref, preset, { permissionMode?, commandId? }?)` | operate | Switch the chat's preset from its next tool call. Answers `{ ok: true, permissionPreset, permissionMode?, notice? }`: the preset in force, lowered to the module's ceiling when it asked for more (and the mode dropped with it). |
| `setModel(ref, modelId)` | operate | Switch to another model of the chat's runtime from its next turn (an id `listChatRuntimes()` lists, or `default`). Answers `{ ok: true, modelId, notice? }`; a runtime that binds a chat to its model refuses. |
| `subscribe(ref, cb)` | read | Live events from now on; returns the unsubscriber. |
| `follow(ref, { afterSeq?, generation?, turnLimit? }?, onFrame)` | read | No gap: a `snapshot` (or only the events after the cursor you hold), a `synchronized` fence, then live events. Keep the fence's `seq` and `generation` as your next cursor; a snapshot with `reset: true` replaces what you held. Returns the unsubscriber. |
| `transcript(ref)` | read | Every recorded event, for catching up. |
| `list(filter?)` / `watch(filter, cb)` | read | The module's own chats: `{ workspaceId, agentId, sessionId, name, cli, providerId, modelId, status, permissionPreset? }`. `watch` fires at once, then on change. |

`ref` is `{ workspaceId, agentId }` — keep it (in `getModuleStorage`) if you
need the chat after a restart.

Every mutating call but `stop` takes a `commandId` of your own (options last
for `interrupt`, `setPermissionPreset` and `setModel`). Reuse it when you
retry: the host answers with the first attempt's result and never carries the
command out twice, even across a restart.

Status: `starting`, `ready` (waiting for a message), `active` (working),
`awaiting_approval`, `stopped`, `failed`, or `absent` (exists, no session
running).

Events (`event.type`): `session_started`, `session_ready`, `session_updated`,
`session_closed`, `user_message`, `turn_started`, `content_delta`,
`reasoning_delta`, `tool_started`, `tool_output`, `approval_requested`,
`approval_resolved`, `usage_updated`, `context_compacted`, `command_output`,
`turn_completed`, `turn_failed`, `subagent_status`, `subagent_message`. The
`payload` shape is per type and not a stable contract: read what you need
defensively, and treat its text as untrusted.

Error codes: `permission_missing`, `invalid_input`, `unknown_workspace`,
`workspace_folder_missing`, `no_cli_selected`, `cli_not_conversational`,
`unknown_skill`, `not_owned`, `agent_write_failed`,
`conversation_start_failed`, `runtime_refused`.

## Scheduled agents start chats too

Each run of a scheduled agent (`getScheduledAgentsService`) is a new chat the
host starts with the scheduled agent's prompt. A run of one the module created
is the module's chat, so the conversation service lists and follows it like
one the module started itself.

## Handling what an agent says

A reply can quote a web page, a diff or an issue that contains instructions.
Treat event payloads and transcripts as data: show them as text, never as
HTML; never run a command, open a URL or write a path an agent chose without
checking it against what your module allows; never pass them to `eval` or
`new Function`.
