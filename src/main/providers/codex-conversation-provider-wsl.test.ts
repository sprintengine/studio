// A Codex chat on a WSL machine, with a stand-in machine: the app-server is
// started inside the distribution from the CLI found there, in the folder as
// Linux names it, with the chat's identity and none of the API auth; Codex is
// spoken to in Linux paths and what it names comes back as this machine opens
// it. Nothing here runs `wsl.exe`.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, test } from 'vitest'

import type { ConversationEvent, ConversationMcpServer } from '../../shared/conversation-runtime'
import { conversationCommandsFor } from '../conversation-commands/registry'
import { createCodexConversationProvider, probeCodexConversationCommands } from './codex-conversation-provider'
import { createCodexRpcTransport, type CodexRpcOptions, type RpcMessage } from './codex-json-rpc'

const ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
const WSL_TARGET = { distro: 'Ubuntu', agentStateSocketPath: '/run/user/1000/sprintengine/agent.sock' }

function decodedScript(args: readonly string[]): string {
  const encoded = /echo (\S+)\|base64 -d/u.exec(args.at(-1) ?? '')?.[1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf8')
}

function wslFixture(mcpServers: ConversationMcpServer[] = []) {
  let connection!: CodexRpcOptions
  const calls: { method: string; params: unknown }[] = []
  const prepared: string[] = []
  let resolveStarted!: () => void
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  const adapter = createCodexConversationProvider({
    prepareWslTarget: async (hostId) => {
      prepared.push(hostId)
      return WSL_TARGET
    },
    resolveExecutable: async () => '/home/dev/.local/bin/codex',
    buildEnv: async () => ({
      PATH: 'C:\\Windows\\System32',
      SPRINTENGINE_AGENT_ID: 'agent',
      SPRINTENGINE_CONVERSATION_SESSION_ID: 'session',
    }),
    createTransport(options) {
      connection = options
      return {
        pid: 42,
        async request(method, params) {
          calls.push({ method, params })
          if (method === 'account/read') return { requiresOpenaiAuth: true, account: { type: 'chatgpt' } }
          if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'native-thread' } }
          if (method === 'skills/list')
            return {
              data: [
                { cwd: '/home/dev/repo', skills: [{ name: 'release-notes', description: 'Notes', enabled: true }] },
              ],
            }
          if (method === 'turn/start') {
            resolveStarted()
            return { turn: { id: 'native-turn' } }
          }
          return {}
        },
        notify: (method, params) => calls.push({ method, params }),
        respond: () => undefined,
        reject: () => undefined,
        close: () => undefined,
      }
    },
  })
  const input = {
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'codex-agent',
    modelId: 'default',
    workspaceRoot: ROOT,
    cliRuntimes: { codex: { command: '', hostId: 'wsl:Ubuntu' as const } },
    ...(mcpServers.length ? { mcpServers } : {}),
  }
  return {
    adapter,
    input,
    calls,
    prepared,
    started,
    get connection() {
      return connection
    },
    message: (value: RpcMessage) => connection.onMessage(value),
  }
}

test('a Codex chat on a WSL machine starts that machine’s app-server in the folder as Linux names it', async () => {
  const f = wslFixture([
    {
      id: 'files',
      name: 'Files',
      transport: 'stdio',
      command: 'C:\\tools\\node.exe',
      args: ['C:\\tools\\files-server.js'],
    },
  ])
  await f.adapter.startSession(f.input)
  const events: ConversationEvent[] = []
  const turn = (async () => {
    for await (const event of (await f.adapter.sendTurn({
      ...f.input,
      turnId: 'turn',
      requestId: 'request',
      message: 'Look around.',
    })) as AsyncIterable<ConversationEvent>)
      events.push(event)
  })()
  await f.started
  expect(f.prepared).toEqual(['wsl:Ubuntu'])
  expect(f.connection.command).toBe('/home/dev/.local/bin/codex')
  expect(f.connection.wsl).toMatchObject({
    distro: 'Ubuntu',
    agentStateSocketPath: WSL_TARGET.agentStateSocketPath,
  })
  expect(f.connection.wsl?.forwardEnv).toEqual(
    expect.arrayContaining(['SPRINTENGINE_AGENT_ID', 'SPRINTENGINE_CONVERSATION_SESSION_ID']),
  )
  expect(f.connection.wsl?.unsetEnv).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'CODEX_API_KEY']))
  // The session's MCP server is started by the Linux side, so its paths are the distribution's.
  expect(f.connection.args?.join(' ')).toContain('"/mnt/c/tools/node.exe"')
  expect(f.connection.args?.join(' ')).toContain('"/mnt/c/tools/files-server.js"')
  expect(f.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({ cwd: '/home/dev/repo' })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.calls.find((call) => call.method === 'skills/list')?.params).toEqual({ cwds: ['/home/dev/repo'] })
  // The menu is keyed by the folder as this machine names it, which is where the chat box looks.
  expect(conversationCommandsFor('codex', ROOT).commands.map((command) => command.name)).toContain('release-notes')

  // A picture Codex saved in the distribution is opened from this machine.
  await f.message({
    method: 'item/completed',
    params: {
      item: {
        id: 'picture',
        type: 'imageGeneration',
        status: 'completed',
        revisedPrompt: null,
        result: '',
        failure: null,
        savedPath: '/home/dev/.codex/generated_images/a.png',
      },
    },
  })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await turn
  const picture = events.find((event) => event.type === 'tool_started' && event.payload?.toolUseId === 'picture')
  expect(picture?.payload?.input).toMatchObject({
    path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.codex\\generated_images\\a.png',
  })
  f.adapter.disposeAll?.()
})

test('a Codex chat on this machine is started as it always was', async () => {
  const f = wslFixture()
  const local = { ...f.input, workspaceRoot: '/Users/dev/repo', cliRuntimes: undefined }
  await f.adapter.startSession(local)
  const turn = (async () => {
    for await (const _ of (await f.adapter.sendTurn({
      ...local,
      turnId: 'turn',
      requestId: 'request',
      message: 'Hi.',
    })) as AsyncIterable<ConversationEvent>);
  })()
  await f.started
  expect(f.prepared).toEqual([])
  expect(f.connection.wsl).toBeNull()
  expect(f.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({ cwd: '/Users/dev/repo' })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await turn
  f.adapter.disposeAll?.()
})

test("Codex's skills for a folder on a WSL machine are asked of that machine's app-server", async () => {
  const asked: unknown[] = []
  let options!: CodexRpcOptions
  const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\probe'
  await probeCodexConversationCommands(
    { cwd, cliRuntimes: { codex: { hostId: 'wsl:Ubuntu' } } },
    {
      prepareWslTarget: async () => WSL_TARGET,
      resolveExecutable: async () => '/home/dev/.local/bin/codex',
      buildEnv: async () => ({}),
      createTransport: (given) => {
        options = given
        return {
          pid: 1,
          async request(method, params) {
            if (method !== 'skills/list') return {}
            asked.push(params)
            return { data: [{ cwd: '/home/dev/probe', skills: [{ name: 'triage', description: '', enabled: true }] }] }
          },
          notify: () => undefined,
          respond: () => undefined,
          reject: () => undefined,
          close: () => undefined,
        }
      },
    },
  )
  expect(options.wsl?.distro).toBe('Ubuntu')
  expect(asked).toEqual([{ cwds: ['/home/dev/probe'] }])
  expect(conversationCommandsFor('codex', cwd).commands.map((command) => command.name)).toContain('triage')
})

test('the app-server for a WSL chat is one wsl.exe running codex inside the distribution', () => {
  const spawned: unknown[][] = []
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 7,
    exitCode: 0 as number | null,
    kill: () => true,
  })
  const transport = createCodexRpcTransport({
    command: '/home/dev/.local/bin/codex',
    cwd: 'C:\\Users\\dev\\repo',
    env: { PATH: 'C:\\Windows', SPRINTENGINE_AGENT_ID: 'agent' },
    platform: 'win32',
    wsl: { ...WSL_TARGET, forwardEnv: ['SPRINTENGINE_AGENT_ID'], unsetEnv: ['OPENAI_API_KEY'] },
    spawnChild: ((...args: unknown[]) => {
      spawned.push(args)
      return child
    }) as unknown as CodexRpcOptions['spawnChild'],
    onMessage: () => undefined,
    onClose: () => undefined,
  })
  const [file, args] = spawned[0] as [string, string[]]
  expect(file).toBe('wsl.exe')
  expect(args.slice(0, 2)).toEqual(['-d', 'Ubuntu'])
  const script = decodedScript(args)
  expect(script).toContain('/home/dev/.local/bin/codex')
  expect(script).toContain('app-server')
  expect(script).toContain('stdio://')
  expect(script).toContain('/mnt/c/Users/dev/repo')
  expect(script).toContain('SPRINTENGINE_AGENT_ID=agent')
  expect(script).not.toContain('C:\\Windows')
  transport.close()
})
