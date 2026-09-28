import { homedir } from 'node:os'
import type { ConversationCliRuntimeOverrides, ConversationProviderSignInResult } from '../shared/conversation-runtime'
import { cliForConversationProvider } from '../shared/conversation-harness'
import { isWslHostId } from '../shared/execution-host'
import { argvToPosixShellCommand } from './agent-launch-render'
import { detectCli } from './cli-runtime-install'

// The CLI's own sign-in, per harness. Only a harness whose chat binds the
// CLI's login (rather than a key Studio stores) is here.
const SIGN_IN_ARGS: Partial<Record<string, string[]>> = {
  'claude-code': ['auth', 'login'],
}

/**
 * The line a plain Studio terminal on this machine runs to sign a chat's CLI
 * back in. It names the executable the conversation provider resolves, not
 * whatever `claude` the shell finds first: on Windows the chat runs the native
 * claude.exe, whose login is not the one inside WSL.
 */
export function signInCommandLine(executablePath: string, args: string[], platform: NodeJS.Platform): string {
  // A plain terminal on Windows opens PowerShell, which runs a quoted path
  // only through the call operator.
  if (platform === 'win32') return `& '${executablePath.replace(/'/g, "''")}' ${args.join(' ')}`
  return argvToPosixShellCommand([executablePath, ...args])
}

export async function resolveConversationSignIn(
  input: { providerId: string; cliRuntimes?: ConversationCliRuntimeOverrides },
  deps: {
    detect?: typeof detectCli
    platform?: NodeJS.Platform
    home?: () => string
  } = {},
): Promise<ConversationProviderSignInResult> {
  const cli = cliForConversationProvider(input.providerId)
  const args = cli ? SIGN_IN_ARGS[cli] : undefined
  if (!cli || !args) return { ok: false, message: 'This provider has no sign-in to run.' }
  const override = input.cliRuntimes?.[cli]
  // The provider refuses a WSL host, so there is no chat login there to renew.
  if (isWslHostId(override?.hostId)) {
    return { ok: false, message: 'Claude conversation agents are not supported on a WSL machine yet.' }
  }
  const detection = await (deps.detect ?? detectCli)(cli, override)
  if (!detection.installed || !detection.resolvedPath) {
    return {
      ok: false,
      message: 'Claude Code CLI is not installed. Install it (or set a command override in Settings) to sign in.',
    }
  }
  const platform = deps.platform ?? process.platform
  return {
    ok: true,
    commandLine: signInCommandLine(detection.resolvedPath, args, platform),
    // Signing in does not depend on the folder; home is a folder every host
    // opens this machine's own shell in, where a workspace on a WSL path would
    // open the distribution's shell instead.
    cwd: (deps.home ?? homedir)(),
    platform,
  }
}
