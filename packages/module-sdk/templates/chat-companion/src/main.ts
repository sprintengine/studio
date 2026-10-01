import { getConversationService, type RegisterMain } from '@sprintengine/module-sdk'

import { CHANGED_TOPIC, CHANNELS, isStartRequest, isStopRequest } from './protocol'

const OPENING_PROMPT =
  "Read this project's README and its main entry point, then summarise in five bullet points what it does and how it is built. Do not change any files."

// Chats a module starts are real chats: they open as tabs in the workspace,
// run on the agent runtime the person last chose (unless `cli` says which),
// and the person can read and answer them like any other. The conversation
// service only ever shows this module its own chats.
export const registerMain: RegisterMain = (host) => {
  // An older host, or one whose chat runtime is off: say so once, rather than
  // failing the module's load at the first call.
  if (!host.supports('conversations')) {
    host.notify({
      severity: 'warning',
      title: '{{displayName}} cannot start chats here',
      body: 'This version of SprintEngine Studio does not offer chats to extensions.',
    })
    return
  }
  const conversations = getConversationService(host)

  host.registerIpc(CHANNELS.list, async () => conversations.list())

  host.registerIpc(CHANNELS.start, async (_event, request) => {
    if (!isStartRequest(request)) return { ok: false, code: 'invalid_input', message: 'Pick a workspace first.' }
    const started = await conversations.create({
      workspaceId: request.workspaceId,
      name: 'Project summary',
      prompt: OPENING_PROMPT,
    })
    if (!started.ok) return started

    // Follow the one turn and say when it is done. Events stream from now on;
    // `transcript(ref)` replays what already happened.
    const ref = { workspaceId: request.workspaceId, agentId: started.conversation.agentId }
    let stop: (() => void) | undefined
    let finished = false
    stop = conversations.subscribe(ref, (event) => {
      if (finished || (event.type !== 'turn_completed' && event.type !== 'turn_failed')) return
      finished = true
      stop?.()
      host.notify({
        severity: event.type === 'turn_completed' ? 'info' : 'warning',
        title: event.type === 'turn_completed' ? 'Project summary is ready' : 'Project summary did not finish',
        body: 'Open it from {{displayName}}.',
      })
    })
    if (finished) stop()
    return started
  })

  host.registerIpc(CHANNELS.stop, async (_event, request) => {
    if (!isStopRequest(request)) return { ok: false, code: 'invalid_input', message: 'Which chat?' }
    return conversations.stop(request)
  })

  // Tell every open window to read the list again whenever it changes. An
  // event is a signal, not state: a window opened later reads through
  // CHANNELS.list and never needs an old event.
  let stopWatching = () => {}
  host.onStartup(() => {
    stopWatching = conversations.watch(undefined, () => host.emit(CHANGED_TOPIC))
  })
  host.onShutdown(() => stopWatching())
}
