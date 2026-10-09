import type { RegisterMain } from '@sprintengine/module-sdk'

// The main entry runs in Studio's main process (Node, no window), once, when
// the module loads. Register here what the window half calls, what agents
// call, and what runs in the background. A service resolved here, at the top,
// needs its provider in `dependsOn` ("agent-runtime" is declared); one
// resolved inside a handler does not.
//
// `{{id}}:status` is a channel the window half reaches with
// `host.invoke('{{id}}:status')`, which needs the "module:bridge" permission.
// Replace it with the module's own channels; they must start with "{{id}}:".
export const registerMain: RegisterMain = (host) => {
  const startedAt = Date.now()
  host.registerIpc('{{id}}:status', () => ({ startedAt }))
}
