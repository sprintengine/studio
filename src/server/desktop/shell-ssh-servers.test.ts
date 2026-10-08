// An SSH machine's chats routed by the desktop's server out of process
// (phase 8 with phase 6): main's side (a real SshEnvironment against a plain
// `sh` standing in for ssh, the real server tree and relay) opens a relay
// stream and splices it onto a message port; the server's side takes the
// port, reads its conversation wire from it, and the router sends a chat
// there. The ports are Node's own MessageChannel, shaped as Electron's.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterAll, beforeAll, test } from 'vitest'

import { SshEnvironment } from '../../main/environments/ssh/ssh-environment'
import { serverTreeDigest } from '../../main/environments/ssh/ssh-install'
import type { SessionProcess } from '../../main/environments/ssh/ssh-session'
import { WSL_NODE_VERSION } from '../../main/hosts/wsl-node-runtime'
import { DEFAULT_SSH_ENVIRONMENT_SETTINGS } from '../../shared/ssh-environments'
import type { ConversationBackend } from '../core/conversation-backend'
import { createRoutedConversationBackend } from '../core/routed-conversation-backend'
import type { TunnelPort } from '../ipc/ipc-tunnel'
import { splicePort } from '../ipc/port-duplex'
import { BACKEND_WIRE_VERSION } from '../wsl/backend-wire'
import { createShellSshServers } from './shell-ssh-servers'

const ROOT = join(__dirname, '..', '..', '..')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
let scratch = ''
let tree = ''
let digest = ''
const pids: number[] = []

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'se-ssh-oop-'))
  tree = join(scratch, 'tree')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.mjs'), '--wsl', '--out-dir', tree], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  digest = serverTreeDigest(tree)
})
afterAll(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone.
    }
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

/** Node's port as Electron's MessagePortMain is shaped: `message` events with `data`. */
function electronShaped(port: MessagePort): TunnelPort {
  return {
    postMessage: (message) => port.postMessage(message),
    on(event: 'message' | 'close', listener: (event: { data: unknown }) => void) {
      if (event === 'message') port.on('message', (data) => listener({ data }))
      else port.on('close', () => (listener as () => void)())
      return this
    },
    start: () => port.start(),
    close: () => port.close(),
  } as TunnelPort
}

test('out of process, a chat on an SSH machine is routed through a port main splices onto the relay', async () => {
  const home = join(scratch, 'home')
  mkdirSync(home)
  const fakeNode = Buffer.from(
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${WSL_NODE_VERSION}; exit 0; fi\nexec '${process.execPath}' "$@"\n`,
  )
  const sessions: Array<ReturnType<typeof spawn>> = []
  const machine = new SshEnvironment({
    id: 'e1',
    label: () => 'build-box',
    settings: () => ({ ...DEFAULT_SSH_ENVIRONMENT_SETTINGS, keepRunning: true }),
    spawn: () => {
      const child = spawn('sh', ['-s'], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      sessions.push(child)
      return child as unknown as SessionProcess
    },
    app: { version: VERSION, channel: 'latest', backendWire: BACKEND_WIRE_VERSION },
    dataName: 'data',
    startedBy: 'Studio on dev-macbook-air',
    serverTree: () => ({ dir: tree, digest }),
    nodeBinary: async () => ({ binary: fakeNode }),
    onChange: () => undefined,
  })
  // Main's side: what `shell.ssh.open` does, with the port handed over by id.
  const handedOver = new Map<string, TunnelPort>()
  const opened: string[] = []
  const shell = createShellSshServers({
    open: async (key, purpose) => {
      opened.push(`${key} ${purpose}`)
      const connection = await machine.connect({ interactive: false })
      const stream = await connection.open(purpose)
      const { port1, port2 } = new MessageChannel()
      const clientId = `ssh-${opened.length}`
      handedOver.set(clientId, electronShaped(port2))
      splicePort(electronShaped(port1), stream)
      return { clientId, label: connection.label }
    },
    takePort: (clientId) => {
      const port = handedOver.get(clientId) ?? null
      handedOver.delete(clientId)
      return port
    },
  })
  // This process's own runtime holds no chats here.
  const local = new Proxy(
    {},
    {
      get: (_t, member) =>
        member === 'onEvent'
          ? () => () => undefined
          : member === 'listSessions'
            ? () => ({ ok: true, sessions: [] })
            : undefined,
    },
  )
  const router = createRoutedConversationBackend({
    local: local as ConversationBackend,
    workspace: () => ({ folderPath: home, environment: { kind: 'ssh', id: 'e1' } }),
    chatServerOn: () => false,
    ssh: shell.servers,
    platform: 'darwin',
  })
  shell.onConnected((connection) => router.attach(connection))
  const events: string[] = []
  router.onEvent((event) => events.push(event.type))

  const started = (await router.startSession({
    workspaceId: 'w1',
    agentId: 'a1',
    workspaceRoot: home,
    providerId: 'mock-provider',
    modelId: 'mock-model',
  } as never)) as { ok: boolean; session: { sessionId: string } }
  assert.ok(started.ok, JSON.stringify(started))
  assert.deepEqual(opened, ['ssh:e1 backend'])
  const record = JSON.parse(
    readFileSync(join(home, '.local', 'share', 'sprintengine-studio', 'data', 'run', 'server.json'), 'utf8'),
  ) as { pid: number }
  pids.push(record.pid)
  assert.ok(events.includes('session_started'), events.join(','))

  // The session's listing comes back through the port too.
  const listed = router.listSessions({ workspaceId: 'w1' })
  assert.ok(listed.ok && listed.sessions.some((session) => session.sessionId === started.session.sessionId))

  // The relay drops (its session dies, as on a dropped network): the port
  // closes, and the next call opens a new one once the machine is back.
  sessions.at(-1)!.kill()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(shell.servers.current('ssh:e1'), null)
  const again = (await router.readTranscript({ workspaceId: 'w1', agentId: 'a1', workspaceRoot: home } as never)) as {
    ok: boolean
  }
  assert.ok(again.ok)
  assert.deepEqual(opened, ['ssh:e1 backend', 'ssh:e1 backend'])
  machine.disconnect()
})
