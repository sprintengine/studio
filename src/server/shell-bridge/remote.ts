import type { AgentLaunchResult } from '../../shared/agent-launch'
import { ControlRpcError, type ControlRpc } from '../bootstrap/control-rpc'
import { SHELL_BRIDGE_EVENTS, SHELL_BRIDGE_METHODS, type ShellBridge } from './shell-bridge'

// The server's `ShellBridge` when the shell is another process: each member is
// a request on the control channel, which the shell serves with its own
// in-process bridge (src/main/server-supervisor/serve-shell-bridge.ts).
//
// A shell that is not there (the channel closed, or it never answered) is a
// failure of that call and nothing more: a seal rejects, a launch answers
// `shell_unavailable`, a reveal answers false, a notice is dropped. Nothing
// here retries; the caller already has a rule for each of those.

/** How long a seal or an open may take: a keychain prompt on a locked Mac is answered by a person. */
const CIPHER_TIMEOUT_MS = 120_000
/** A terminal launch writes a launcher and spawns a pty; the shell's own budget is shorter. */
const LAUNCH_TIMEOUT_MS = 60_000
/** The launcher and plugin home are written at boot; past this, launches stop waiting for them. */
const INTEGRATIONS_TIMEOUT_MS = 120_000

export function createRemoteShellBridge(rpc: ControlRpc): ShellBridge {
  // One question, answered by the shell once its launcher and plugin home are
  // written (at once for a server that starts after that). Like the gate it
  // stands for, it never fails: a shell that cannot answer lets launches go
  // ahead, and each launch reports its own failure.
  let integrations: Promise<void> | null = null

  const bytes = async (method: string, input: Uint8Array): Promise<Uint8Array> => {
    const value = await rpc.call<unknown>(method, input, { timeoutMs: CIPHER_TIMEOUT_MS })
    if (!(value instanceof Uint8Array)) throw new Error(`${method} answered something other than bytes.`)
    return value
  }

  return {
    cipher: {
      available: () => rpc.call<boolean>(SHELL_BRIDGE_METHODS.cipherAvailable).catch(() => false),
      seal: (plain) => bytes(SHELL_BRIDGE_METHODS.cipherSeal, plain),
      open: (sealed) => bytes(SHELL_BRIDGE_METHODS.cipherOpen, sealed),
    },
    terminals: {
      launchAgent: (request) =>
        rpc
          .call<AgentLaunchResult>(SHELL_BRIDGE_METHODS.launchAgent, request, { timeoutMs: LAUNCH_TIMEOUT_MS })
          .catch((error: unknown): AgentLaunchResult => ({
            ok: false,
            code: 'shell_unavailable',
            message:
              error instanceof ControlRpcError && error.code !== 'failed'
                ? 'Studio’s window process is not answering, so no terminal agent can start right now.'
                : error instanceof Error
                  ? error.message
                  : String(error),
          })),
    },
    reveal: {
      tab: (target) => rpc.call<boolean>(SHELL_BRIDGE_METHODS.revealTab, target).catch(() => false),
    },
    notify(notice) {
      rpc.emit(SHELL_BRIDGE_EVENTS.notify, notice)
    },
    analytics(event) {
      rpc.emit(SHELL_BRIDGE_EVENTS.analytics, event)
    },
    integrationsReady() {
      integrations ??= rpc
        .call(SHELL_BRIDGE_METHODS.integrationsReady, undefined, { timeoutMs: INTEGRATIONS_TIMEOUT_MS })
        .then(
          () => undefined,
          () => undefined,
        )
      return integrations
    },
  }
}
