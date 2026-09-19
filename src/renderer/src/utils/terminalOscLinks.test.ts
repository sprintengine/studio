import assert from 'node:assert/strict'
import type { IBufferRange } from '@xterm/xterm'
import {
  createTerminalOscLinkHandler,
  createTerminalSurfaceOscLinkHandler,
  parseTerminalOscCwd,
  resolveTerminalOscLink,
} from './terminalOscLinks'
import { terminalSurfaceLinkRoots, type TerminalSurface } from './terminalSurfaces'
import { test } from 'vitest'

test('terminalOscLinks', async () => {
  // OSC 8 payloads are attacker-controlled: any agent CLI, and any `cat` of any
  // file an agent was handed, can print one. These tests are the gate.

  // `windowsPaths` is stated rather than inherited from the host: the Windows
  // spellings have to be provable from a Mac and refusable from one.
  const LOCAL = { allowLocalPaths: true, windowsPaths: false }
  const FLEET = { allowLocalPaths: false, windowsPaths: false }
  const WINDOWS = { allowLocalPaths: true, windowsPaths: true }

  // The surfaces the panes actually construct. `allowLocalPaths` is derived from
  // these and never written down anywhere else.
  const AGENT_SURFACE: TerminalSurface = { kind: 'agent', workspaceRoot: '/w', executionRoot: null }
  const SHELL_SURFACE: TerminalSurface = { kind: 'shell', workspaceRoot: '/w' }
  const FLEET_SURFACE: TerminalSurface = { kind: 'fleet' }

  // ---------- scheme allowlist ----------

  assert.deepEqual(resolveTerminalOscLink('https://example.com/a', LOCAL), {
    kind: 'url',
    url: 'https://example.com/a',
  })
  assert.deepEqual(resolveTerminalOscLink('http://example.com/a', LOCAL), { kind: 'url', url: 'http://example.com/a' })
  assert.deepEqual(resolveTerminalOscLink('file:///Users/dev/notes.md', LOCAL), {
    kind: 'file',
    path: '/Users/dev/notes.md',
  })

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
    assert.equal(resolveTerminalOscLink(hostile, LOCAL), null, `refused off the allowlist: ${JSON.stringify(hostile)}`)
  }

  // A scheme is matched case-insensitively by the URL parser, so the allowlist
  // cannot be walked past by shouting.
  assert.deepEqual(resolveTerminalOscLink('HTTPS://example.com/a', LOCAL), {
    kind: 'url',
    url: 'https://example.com/a',
  })
  assert.deepEqual(resolveTerminalOscLink('FILE:///Users/dev/notes.md', LOCAL), {
    kind: 'file',
    path: '/Users/dev/notes.md',
  })

  // ---------- a file: URI naming another host ----------

  // The whole point of the rule: `/etc/hosts` exists on this machine too, and
  // opening it for a link that named someone else's would show a different file
  // under the same name with nothing on screen to tell them apart.
  assert.equal(resolveTerminalOscLink('file://other-machine/etc/hosts', LOCAL), null)
  assert.equal(resolveTerminalOscLink('file://192.168.1.9/Users/dev/notes.md', LOCAL), null)
  assert.equal(resolveTerminalOscLink('file://evil.example.com/tmp/x', LOCAL), null)

  // `localhost` IS this machine, and the URL parser normalises it to no host at
  // all — which is exactly the spelling the empty-host rule accepts.
  assert.deepEqual(resolveTerminalOscLink('file://localhost/Users/dev/notes.md', LOCAL), {
    kind: 'file',
    path: '/Users/dev/notes.md',
  })

  // ---------- a fleet pane never resolves a local path ----------

  assert.equal(
    resolveTerminalOscLink('file:///Users/dev/notes.md', FLEET),
    null,
    'a fleet pane is attached to another machine; a local path is never its answer',
  )
  assert.equal(resolveTerminalOscLink('file://localhost/etc/hosts', FLEET), null)
  // A URL means the same thing from either machine, so it still resolves.
  assert.deepEqual(resolveTerminalOscLink('https://example.com/a', FLEET), {
    kind: 'url',
    url: 'https://example.com/a',
  })

  // ---------- decoding ----------

  assert.deepEqual(resolveTerminalOscLink('file:///Users/dev/my%20notes.md', LOCAL), {
    kind: 'file',
    path: '/Users/dev/my notes.md',
  })
  assert.deepEqual(
    resolveTerminalOscLink('file:///a/b/../c', LOCAL),
    { kind: 'file', path: '/a/c' },
    'the URL parser resolves dot segments before we ever see the path',
  )
  assert.deepEqual(
    resolveTerminalOscLink('file:///C:/Users/dev/notes.md', WINDOWS),
    { kind: 'file', path: 'C:\\Users\\dev\\notes.md' },
    'a Windows drive path comes back in the form the platform can stat',
  )

  // ---------- the Windows spellings are refused off Windows ----------
  //
  // `C:\Users\dev\notes.md` on macOS or Linux is not a path at all: it is a
  // RELATIVE name whose backslashes are ordinary filename characters, and handing
  // it to `statPath` breaks the module's own rule 4. Same for the UNC form, which
  // off Windows names another machine — rule 2 in a different spelling.
  assert.equal(
    resolveTerminalOscLink('file:///C:/Users/dev/notes.md', LOCAL),
    null,
    'a drive letter is a Windows spelling and this is not Windows',
  )
  assert.equal(resolveTerminalOscLink('file:///c:/Users/dev/notes.md', LOCAL), null)
  assert.equal(
    resolveTerminalOscLink('file:////server/share/notes.md', LOCAL),
    null,
    'a UNC share off Windows is another machine, not //server on this one',
  )
  assert.deepEqual(
    resolveTerminalOscLink('file:////server/share/notes.md', WINDOWS),
    { kind: 'file', path: '\\\\server\\share\\notes.md' },
    'on Windows the same payload is the share it names',
  )
  assert.equal(
    resolveTerminalOscLink('file:////server', WINDOWS),
    null,
    'a server with no share names a machine, not a file on it',
  )
  assert.equal(
    resolveTerminalOscLink('file:////server/share/%2e%2e/%2e%2e/x', WINDOWS),
    null,
    'a traversal that climbs back out of the share is not a path on it',
  )
  assert.equal(resolveTerminalOscLink('file:///C:/%2e%2e', WINDOWS), null, 'nor is a drive root')

  // ---------- `..` is collapsed, however it was spelled ----------
  //
  // The URL parser collapses BARE dot segments only, so `%2e%2e%2f` survives the
  // parse and `decodeURIComponent` puts the traversal straight back. That matters
  // because `projectRelativePath` (terminalLinkActions.ts) is a PREFIX
  // comparison: un-normalised, `file:///w/../../etc/passwd` reports as inside the
  // workspace `/w` with the relative path `../../etc/passwd`, and that string is
  // what the link menu shows the user.
  assert.deepEqual(
    resolveTerminalOscLink('file:///Users/dev/%2e%2e/%2e%2e/etc/passwd', LOCAL),
    { kind: 'file', path: '/etc/passwd' },
    'a percent-encoded traversal is collapsed, not carried through',
  )
  assert.deepEqual(
    resolveTerminalOscLink('file:///Users/dev/%2E%2E%2Fnotes.md', LOCAL),
    { kind: 'file', path: '/Users/notes.md' },
    'upper-case escapes and an encoded slash are the same traversal',
  )
  assert.deepEqual(
    resolveTerminalOscLink('file:///Users//dev/./notes.md', LOCAL),
    { kind: 'file', path: '/Users/dev/notes.md' },
    'doubled separators and a bare dot segment collapse too',
  )
  assert.equal(
    resolveTerminalOscLink('file:///%2e%2e/%2e%2e/%2e%2e', LOCAL),
    null,
    'a traversal that leaves nothing but the root is the same non-answer as file:///',
  )
  assert.deepEqual(
    resolveTerminalOscLink('file:///C:/Users/%2e%2e/dev/notes.md', WINDOWS),
    { kind: 'file', path: 'C:\\dev\\notes.md' },
    'the drive is a root, so `..` cannot climb past it either',
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

  /**
   * A handler built the way a PANE builds one: from the surface, through the same
   * function `createStudioTerminal` calls, so `allowLocalPaths` is derived here
   * exactly as it is in production rather than written down a second time.
   */
  function handlerFor(
    surface: TerminalSurface,
    info: { exists: boolean; isDirectory: boolean } = { exists: true, isDirectory: false },
  ): { activate: (text: string) => void; seen: Activation; settled: () => Promise<void> } {
    const seen: Activation = { files: [], urls: [], errors: [] }
    const pending: Array<Promise<unknown>> = []
    const handler = createTerminalSurfaceOscLinkHandler(surface, {
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
    const agent = handlerFor(AGENT_SURFACE)
    agent.activate('file:///Users/dev/notes.md')
    agent.activate('https://example.com/a')
    agent.activate('javascript:alert(1)')
    agent.activate('file://other-machine/etc/hosts')
    await agent.settled()
    assert.deepEqual(agent.seen.files, ['/Users/dev/notes.md'])
    assert.deepEqual(agent.seen.urls, ['https://example.com/a'])
    assert.deepEqual(agent.seen.errors, [], 'a refusal is silent — no popover, no message')
  }

  // The regression this replaces: the old version of this test built a handler
  // with `allowLocalPaths: false` by hand — a handler production never
  // constructed, because `FleetTerminalPanel` passed NO link handler at all and
  // xterm's own `defaultActivate` (a `confirm()` and a `window.open()`, which
  // this app turns into `shell.openExternal`) answered every OSC 8 click in a
  // fleet pane. It passed either way. This one starts from the surface literal
  // the pane writes, and runs it through the same constructor
  // `createStudioTerminal` uses.
  async function testAFleetPaneNeverResolvesALocalPath(): Promise<void> {
    assert.equal(
      terminalSurfaceLinkRoots(FLEET_SURFACE),
      null,
      'the surface, not the pane, is what says a fleet terminal has no local roots',
    )
    const fleet = handlerFor(FLEET_SURFACE)
    fleet.activate('file:///Users/dev/notes.md')
    fleet.activate('file://localhost/etc/hosts')
    fleet.activate('https://example.com/a')
    fleet.activate('javascript:alert(1)')
    await fleet.settled()
    assert.deepEqual(fleet.seen.files, [], 'a fleet pane never opens a local path')
    assert.deepEqual(
      fleet.seen.urls,
      ['https://example.com/a'],
      'http(s) rides the app chooser rather than xterm defaultActivate',
    )
    assert.deepEqual(fleet.seen.errors, [])
  }

  // A shell pane derives the other answer from the same function, so the
  // derivation is a rule about surfaces rather than a constant that happens to
  // read false.
  async function testAShellPaneStillResolvesALocalPath(): Promise<void> {
    const shell = handlerFor(SHELL_SURFACE)
    shell.activate('file:///Users/dev/notes.md')
    await shell.settled()
    assert.deepEqual(shell.seen.files, ['/Users/dev/notes.md'])
  }

  async function testADeadLinkShowsTheErrorRatherThanAMenu(): Promise<void> {
    const missing = handlerFor(AGENT_SURFACE, { exists: false, isDirectory: false })
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
  assert.equal(parseTerminalOscCwd('file:///Users/dev/my%20project', LOCAL), '/Users/dev/my project')
  assert.equal(
    parseTerminalOscCwd('file://other-machine/Users/dev/project', LOCAL),
    null,
    "another machine cannot set this pane's resolution base",
  )
  assert.equal(
    parseTerminalOscCwd('https://example.com/', LOCAL),
    null,
    'OSC 7 is defined as a file: URI; anything else is malformed, not a link',
  )
  assert.equal(parseTerminalOscCwd('/Users/dev/project', LOCAL), null, 'a bare path is not a URI')
  assert.equal(parseTerminalOscCwd('file:///Users/dev/project', FLEET), null, 'a fleet pane has no local base to set')

  async function main(): Promise<void> {
    await testAnAgentPaneOpensOnlyWhatSurvivesTheGate()
    await testAFleetPaneNeverResolvesALocalPath()
    await testAShellPaneStillResolvesALocalPath()
    await testADeadLinkShowsTheErrorRatherThanAMenu()
    console.log('ok - terminalOscLinks')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

  await suiteRun
})
