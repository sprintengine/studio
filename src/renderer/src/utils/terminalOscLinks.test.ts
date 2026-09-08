import assert from 'node:assert/strict'
import type { IBufferRange } from '@xterm/xterm'
import {
  createTerminalOscLinkHandler,
  parseTerminalOscCwd,
  resolveTerminalOscLink,
} from './terminalOscLinks'

// OSC 8 payloads are attacker-controlled: any agent CLI, and any `cat` of any
// file an agent was handed, can print one. These tests are the gate.

const LOCAL = { allowLocalPaths: true }
const FLEET = { allowLocalPaths: false }

// ---------- scheme allowlist ----------

assert.deepEqual(
  resolveTerminalOscLink('https://example.com/a', LOCAL),
  { kind: 'url', url: 'https://example.com/a' },
)
assert.deepEqual(
  resolveTerminalOscLink('http://example.com/a', LOCAL),
  { kind: 'url', url: 'http://example.com/a' },
)
assert.deepEqual(
  resolveTerminalOscLink('file:///Users/dev/notes.md', LOCAL),
  { kind: 'file', path: '/Users/dev/notes.md' },
)

// Everything else is refused, silently. `javascript:` is the one that would
// execute; the rest would each hand a different subsystem something it should
// never have been asked to open.
for (const hostile of [
  'javascript:alert(document.cookie)',
  'JavaScript:alert(1)',
  '  javascript:alert(1)  ',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  'blob:https://example.com/1234',
  'ftp://example.com/x',
  'ssh://example.com/x',
  'chrome://settings',
  'about:blank',
  'mailto:someone@example.com',
  'file:/etc/passwd\u0000.txt',
  'not a uri at all',
  '',
  '   ',
]) {
  assert.equal(
    resolveTerminalOscLink(hostile, LOCAL),
    null,
    `refused off the allowlist: ${JSON.stringify(hostile)}`,
  )
}

// A scheme is matched case-insensitively by the URL parser, so the allowlist
// cannot be walked past by shouting.
assert.deepEqual(
  resolveTerminalOscLink('HTTPS://example.com/a', LOCAL),
  { kind: 'url', url: 'https://example.com/a' },
)
assert.deepEqual(
  resolveTerminalOscLink('FILE:///Users/dev/notes.md', LOCAL),
  { kind: 'file', path: '/Users/dev/notes.md' },
)

// ---------- a file: URI naming another host ----------

// The whole point of the rule: `/etc/hosts` exists on this machine too, and
// opening it for a link that named someone else's would show a different file
// under the same name with nothing on screen to tell them apart.
assert.equal(resolveTerminalOscLink('file://other-machine/etc/hosts', LOCAL), null)
assert.equal(resolveTerminalOscLink('file://192.168.1.9/Users/dev/notes.md', LOCAL), null)
assert.equal(resolveTerminalOscLink('file://evil.example.com/tmp/x', LOCAL), null)

// `localhost` IS this machine, and the URL parser normalises it to no host at
// all — which is exactly the spelling the empty-host rule accepts.
assert.deepEqual(
  resolveTerminalOscLink('file://localhost/Users/dev/notes.md', LOCAL),
  { kind: 'file', path: '/Users/dev/notes.md' },
)

// ---------- a fleet pane never resolves a local path ----------

assert.equal(
  resolveTerminalOscLink('file:///Users/dev/notes.md', FLEET),
  null,
  'a fleet pane is attached to another machine; a local path is never its answer',
)
assert.equal(resolveTerminalOscLink('file://localhost/etc/hosts', FLEET), null)
// A URL means the same thing from either machine, so it still resolves.
assert.deepEqual(
  resolveTerminalOscLink('https://example.com/a', FLEET),
  { kind: 'url', url: 'https://example.com/a' },
)

// ---------- decoding ----------

assert.deepEqual(
  resolveTerminalOscLink('file:///Users/dev/my%20notes.md', LOCAL),
  { kind: 'file', path: '/Users/dev/my notes.md' },
)
assert.deepEqual(
  resolveTerminalOscLink('file:///a/b/../c', LOCAL),
  { kind: 'file', path: '/a/c' },
  'the URL parser resolves dot segments before we ever see the path',
)
assert.deepEqual(
  resolveTerminalOscLink('file:///C:/Users/dev/notes.md', LOCAL),
  { kind: 'file', path: 'C:\\Users\\dev\\notes.md' },
  'a Windows drive path comes back in the form the platform can stat',
)
assert.equal(
  resolveTerminalOscLink('file:///Users/dev/%E0%A4%A.md', LOCAL),
  null,
  'a truncated percent escape is refused, never used raw',
)
assert.equal(
  resolveTerminalOscLink('file:///Users/dev/%00etc/passwd', LOCAL),
  null,
  'an embedded NUL would mean one thing here and another at the syscall',
)
assert.equal(resolveTerminalOscLink('file://', LOCAL), null, 'no path at all')
assert.equal(resolveTerminalOscLink('file:///', LOCAL), null, 'the filesystem root is not a link')
assert.equal(resolveTerminalOscLink('file:///C:/', LOCAL), null, 'nor is a bare drive root')

// ---------- the handler ----------

const RANGE: IBufferRange = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } }
const CLICK = { clientX: 12, clientY: 34 } as MouseEvent

type Activation = { files: string[]; urls: string[]; errors: string[] }

function handlerFor(
  allowLocalPaths: boolean,
  info: { exists: boolean; isDirectory: boolean } = { exists: true, isDirectory: false },
): { activate: (text: string) => void; seen: Activation; settled: () => Promise<void> } {
  const seen: Activation = { files: [], urls: [], errors: [] }
  const pending: Array<Promise<unknown>> = []
  const handler = createTerminalOscLinkHandler({
    allowLocalPaths,
    inspectPath: (path) => {
      const result = Promise.resolve(info)
      pending.push(result)
      void path
      return result
    },
    onActivateFile: ({ resolvedPath }) => {
      seen.files.push(resolvedPath)
    },
    onActivateUrl: (url) => {
      seen.urls.push(url)
    },
    onOpenError: (message) => {
      seen.errors.push(message)
    },
  })
  return {
    activate: (text) => handler.activate(CLICK, text, RANGE),
    seen,
    // The file branch stats the path first, so give the microtasks a turn.
    settled: async () => {
      await Promise.all(pending)
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

async function testAnAgentPaneOpensOnlyWhatSurvivesTheGate(): Promise<void> {
  const agent = handlerFor(true)
  agent.activate('file:///Users/dev/notes.md')
  agent.activate('https://example.com/a')
  agent.activate('javascript:alert(1)')
  agent.activate('file://other-machine/etc/hosts')
  await agent.settled()
  assert.deepEqual(agent.seen.files, ['/Users/dev/notes.md'])
  assert.deepEqual(agent.seen.urls, ['https://example.com/a'])
  assert.deepEqual(agent.seen.errors, [], 'a refusal is silent — no popover, no message')
}

async function testAFleetPaneNeverResolvesALocalPath(): Promise<void> {
  const fleet = handlerFor(false)
  fleet.activate('file:///Users/dev/notes.md')
  fleet.activate('https://example.com/a')
  await fleet.settled()
  assert.deepEqual(fleet.seen.files, [], 'a fleet pane never opens a local path')
  assert.deepEqual(fleet.seen.urls, ['https://example.com/a'])
}

async function testADeadLinkShowsTheErrorRatherThanAMenu(): Promise<void> {
  const missing = handlerFor(true, { exists: false, isDirectory: false })
  missing.activate('file:///Users/dev/gone.md')
  await missing.settled()
  assert.deepEqual(missing.seen.files, [])
  assert.deepEqual(missing.seen.errors, ['File does not exist: /Users/dev/gone.md'])
}

// xterm drops every non-http link before the handler is consulted unless this
// is on, and `file:` is the only scheme Claude Code emits an OSC 8 for. The
// protection the option's docs demand is `resolveTerminalOscLink`, asserted above.
assert.equal(
  createTerminalOscLinkHandler({
    allowLocalPaths: true,
    inspectPath: async () => ({ exists: true, isDirectory: false }),
    onActivateFile: () => {},
    onActivateUrl: () => {},
  }).allowNonHttpProtocols,
  true,
)

// ---------- OSC 7 ----------

assert.equal(parseTerminalOscCwd('file:///Users/dev/project', LOCAL), '/Users/dev/project')
assert.equal(parseTerminalOscCwd('file://localhost/Users/dev/project', LOCAL), '/Users/dev/project')
assert.equal(
  parseTerminalOscCwd('file:///Users/dev/my%20project', LOCAL),
  '/Users/dev/my project',
)
assert.equal(
  parseTerminalOscCwd('file://other-machine/Users/dev/project', LOCAL),
  null,
  'another machine cannot set this pane\'s resolution base',
)
assert.equal(
  parseTerminalOscCwd('https://example.com/', LOCAL),
  null,
  'OSC 7 is defined as a file: URI; anything else is malformed, not a link',
)
assert.equal(parseTerminalOscCwd('/Users/dev/project', LOCAL), null, 'a bare path is not a URI')
assert.equal(
  parseTerminalOscCwd('file:///Users/dev/project', FLEET),
  null,
  'a fleet pane has no local base to set',
)

async function main(): Promise<void> {
  await testAnAgentPaneOpensOnlyWhatSurvivesTheGate()
  await testAFleetPaneNeverResolvesALocalPath()
  await testADeadLinkShowsTheErrorRatherThanAMenu()
  console.log('ok - terminalOscLinks')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
