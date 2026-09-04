import assert from 'node:assert/strict'

import { descendantPids, parseListeningSockets } from './browser-manager'
import { parsePsTree } from '../terminal-subtree-probe'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output for a vite server, a Next server
// bound to a LAN address, and a database that is not a web server.
const LSOF = [
  'p4242',
  'cnode',
  'n*:5173',
  'n[::1]:5173',
  'p4300',
  'cnext-server',
  'n192.168.1.20:3000',
  'p900',
  'cpostgres',
  'n127.0.0.1:5432',
  '',
].join('\n')

run('listening sockets: loopback and wildcard binds, one row per socket, LAN binds skipped', () => {
  assert.deepEqual(parseListeningSockets(LSOF), [
    { pid: 4242, command: 'node', port: 5173 },
    { pid: 4242, command: 'node', port: 5173 },
    { pid: 900, command: 'postgres', port: 5432 },
  ])
  assert.deepEqual(parseListeningSockets(''), [])
})

// ps -axo pid=,ppid=,pcpu=,args=
const PS = [
  '  100     1  0.0 /bin/zsh -l',
  '  200   100  0.0 npm run dev',
  '  4242  200 12.0 node vite',
  '  4300     1  0.0 node next',
  '  900     1  0.0 postgres',
].join('\n')

run('descendant pids walk the pty shell subtree only', () => {
  const procs = parsePsTree(PS)
  assert.deepEqual([...descendantPids(100, procs)].sort((a, b) => a - b), [200, 4242])
  assert.deepEqual([...descendantPids(4300, procs)], [])
  assert.deepEqual([...descendantPids(999, procs)], [])
})

console.log('browser-manager tests passed')
