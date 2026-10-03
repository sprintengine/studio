import { expect, test } from 'vitest'

import { listAgentListeners } from './preview-ports'

// A machine with the server (pid 100), an agent it spawned (200), the agent's
// dev server (300), and an unrelated process (900) that also listens.

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
const row = (address: string, state: string, inode: string) =>
  `   0: ${address} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  501        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`

function fakeProc(): { files: Record<string, string>; dirs: Record<string, string[]>; links: Record<string, string> } {
  return {
    files: {
      '/proc/net/tcp':
        HEADER +
        row('0100007F:1B58', '0A', '1001') + // 127.0.0.1:7000, the server's own
        row('00000000:0BB8', '0A', '3001') + // 0.0.0.0:3000, the dev server
        row('0101A8C0:0BB9', '0A', '3002') + // 192.168.1.1:3001, the dev server on one address
        row('0100007F:2328', '0A', '9001') + // 127.0.0.1:9000, unrelated
        row('0100007F:1F90', '01', '3003'), // an established connection, not a listener
      '/proc/net/tcp6': HEADER + row('00000000000000000000000001000000:5E7E', '0A', '3004'), // [::1]:24190
      '/proc/100/stat': '100 (node) S 1 100',
      '/proc/200/stat': '200 (claude (agent)) S 100 200',
      '/proc/300/stat': '300 (node) S 200 300',
      '/proc/900/stat': '900 (python3) S 1 900',
      '/proc/300/cmdline': 'node\0/Users/dev/app/node_modules/.bin/vite\0',
    },
    dirs: {
      '/proc': ['1', '100', '200', '300', '900', 'net', 'self'],
      '/proc/100/fd': ['3'],
      '/proc/200/fd': [],
      '/proc/300/fd': ['10', '11', '12', '13'],
      '/proc/900/fd': ['4'],
    },
    links: {
      '/proc/100/fd/3': 'socket:[1001]',
      '/proc/300/fd/10': 'socket:[3001]',
      '/proc/300/fd/11': 'socket:[3002]',
      '/proc/300/fd/12': 'socket:[3004]',
      '/proc/300/fd/13': '/Users/dev/app/vite.config.ts',
      '/proc/900/fd/4': 'socket:[9001]',
    },
  }
}

function linuxDeps(proc = fakeProc()) {
  return {
    readFile: async (path: string) => {
      if (!(path in proc.files)) throw new Error(`ENOENT ${path}`)
      return proc.files[path]
    },
    readdir: async (path: string) => {
      if (!(path in proc.dirs)) throw new Error(`ENOENT ${path}`)
      return proc.dirs[path]
    },
    readlink: async (path: string) => {
      if (!(path in proc.links)) throw new Error(`ENOENT ${path}`)
      return proc.links[path]
    },
  }
}

test('linux: an agent’s dev server on loopback or a wildcard is listed, with its command', async () => {
  const listed = await listAgentListeners({ rootPid: 100, ownPorts: [7000], platform: 'linux', ...linuxDeps() })
  expect(listed).toEqual([
    { port: 3000, pid: 300, command: 'node /Users/dev/app/node_modules/.bin/vite' },
    { port: 24190, pid: 300, command: 'node /Users/dev/app/node_modules/.bin/vite' },
  ])
})

test('linux: the server’s own listener, a specific network address and an unrelated process are never listed', async () => {
  const listed = await listAgentListeners({ rootPid: 100, ownPorts: [7000, 24190], platform: 'linux', ...linuxDeps() })
  expect(listed.map((entry) => entry.port)).toEqual([3000])
})

test('linux: a /proc that cannot be read is an empty list, not a failure', async () => {
  const listed = await listAgentListeners({
    rootPid: 100,
    ownPorts: [],
    platform: 'linux',
    readFile: async () => {
      throw new Error('EACCES')
    },
    readdir: async () => [],
    readlink: async () => '',
  })
  expect(listed).toEqual([])
})

const PS = [
  '  1     0 /sbin/launchd',
  '100     1 node',
  '200   100 claude',
  '300   200 node',
  '900     1 python3',
].join('\n')

function macExec(lsof: string) {
  const calls: string[][] = []
  return {
    calls,
    exec: async (file: string, args: string[]) => {
      calls.push([file, ...args])
      if (file === 'ps') return PS
      if (file === 'lsof') return lsof
      throw new Error(`unexpected ${file}`)
    },
  }
}

test('macos: lsof is asked about the agents’ processes only, and their loopback listeners are listed', async () => {
  const fake = macExec(
    [
      'p300',
      'cnode',
      'f21',
      'n*:3000',
      'f22',
      'n192.168.1.1:3001',
      'f23',
      'n[::1]:24190',
      'p100',
      'cnode',
      'f5',
      'n127.0.0.1:7000',
    ].join('\n'),
  )
  const listed = await listAgentListeners({ rootPid: 100, ownPorts: [7000], platform: 'darwin', exec: fake.exec })
  expect(listed).toEqual([
    { port: 3000, pid: 300, command: 'node' },
    { port: 24190, pid: 300, command: 'node' },
  ])
  const asked = fake.calls.find(([file]) => file === 'lsof') ?? []
  expect(asked.at(-1)?.split(',').sort()).toEqual(['200', '300'])
})

test('macos: no agents means lsof is not asked at all', async () => {
  const fake = macExec('')
  const listed = await listAgentListeners({ rootPid: 4242, ownPorts: [], platform: 'darwin', exec: fake.exec })
  expect(listed).toEqual([])
  expect(fake.calls.map(([file]) => file)).toEqual(['ps'])
})

test('another platform lists nothing', async () => {
  expect(await listAgentListeners({ rootPid: 100, ownPorts: [], platform: 'win32' })).toEqual([])
})
