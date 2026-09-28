import { afterEach, expect, test, vi } from 'vitest'

const openedTabs: Array<{ workspaceId: string; terminalId: string; name?: string }> = []
vi.mock('../../../utils/modelRegistry', () => ({
  focusOrAddTerminalTab: (workspaceId: string, terminalId: string, name?: string) => {
    openedTabs.push({ workspaceId, terminalId, name })
    return true
  },
}))

import { openCliSignInTerminal } from './cliSignIn'

type Calls = { spawns: unknown[][]; writes: Array<{ sessionId: string; data: string }>; signIns: unknown[] }

function installApi(input: {
  signIn?: { ok: true; commandLine: string; cwd: string; platform: string } | { ok: false; message: string }
  spawnFails?: string
}): Calls {
  const calls: Calls = { spawns: [], writes: [], signIns: [] }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        conversationProviderSignIn: async (request: unknown) => {
          calls.signIns.push(request)
          return (
            input.signIn ?? {
              ok: true as const,
              commandLine: "& 'C:\\Users\\me\\.local\\bin\\claude.exe' auth login",
              cwd: 'C:\\Users\\me',
              platform: 'win32',
            }
          )
        },
        terminalSpawn: async (...args: unknown[]) => {
          calls.spawns.push(args)
          return input.spawnFails
            ? { ok: false as const, sessionId: String(args[0]), message: input.spawnFails, exitCode: 1 }
            : { ok: true as const, sessionId: String(args[0]) }
        },
        terminalWrite: async (sessionId: string, data: string) => {
          calls.writes.push({ sessionId, data })
        },
      },
    },
  })
  return calls
}

afterEach(() => {
  openedTabs.length = 0
})

test('Sign in opens a shell tab on this machine and runs the sign-in the chat provider resolved', async () => {
  const calls = installApi({})
  const result = await openCliSignInTerminal({
    workspaceId: 'ws-1',
    providerId: 'claude-agent',
    cliRuntimes: { 'claude-code': { command: 'C:\\Users\\me\\.local\\bin\\claude.exe' } },
    now: () => 42,
  })

  expect(result).toEqual({ ok: true })
  expect(calls.signIns).toEqual([
    {
      providerId: 'claude-agent',
      cliRuntimes: { 'claude-code': { command: 'C:\\Users\\me\\.local\\bin\\claude.exe' } },
    },
  ])
  // A plain shell (shellOnly), in the folder main chose, pinned to this machine
  // so a workspace inside WSL does not open the distribution's shell instead.
  const [sessionId, , , cwd, resume, cli, , , shellOnly, metadata] = calls.spawns[0]
  expect(sessionId).toBe('terminal-sign-in-42')
  expect(cwd).toBe('C:\\Users\\me')
  expect(resume).toBe(false)
  expect(cli).toBeUndefined()
  expect(shellOnly).toBe(true)
  expect(metadata).toEqual({ kind: 'terminal', workspaceId: 'ws-1', terminalId: 'sign-in-42', hostId: 'local' })
  expect(calls.writes).toEqual([
    { sessionId: 'terminal-sign-in-42', data: "& 'C:\\Users\\me\\.local\\bin\\claude.exe' auth login\r" },
  ])
  expect(openedTabs).toEqual([{ workspaceId: 'ws-1', terminalId: 'sign-in-42', name: 'Sign in' }])
})

test('a sign-in main cannot resolve opens nothing and says why', async () => {
  const calls = installApi({ signIn: { ok: false, message: 'Claude Code CLI is not installed.' } })
  const result = await openCliSignInTerminal({ workspaceId: 'ws-1', providerId: 'claude-agent' })

  expect(result).toEqual({ ok: false, message: 'Claude Code CLI is not installed.' })
  expect(calls.spawns).toEqual([])
  expect(openedTabs).toEqual([])
})

test('a terminal that fails to start opens no tab and reports the spawn failure', async () => {
  const calls = installApi({ spawnFails: 'powershell.exe not found' })
  const result = await openCliSignInTerminal({ workspaceId: 'ws-1', providerId: 'claude-agent' })

  expect(result).toEqual({ ok: false, message: 'powershell.exe not found' })
  expect(calls.writes).toEqual([])
  expect(openedTabs).toEqual([])
})
