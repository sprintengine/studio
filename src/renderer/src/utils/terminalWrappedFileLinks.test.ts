import assert from 'node:assert/strict'
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { ILink, Terminal as XtermTerminal } from '@xterm/xterm'
import { TERMINAL_CELL_GEOMETRY_OPTIONS, TERMINAL_UNICODE_VERSION } from '../../../shared/terminal-options'
import {
  createTerminalFileLinkProvider,
  resolveTerminalFileReferencePath,
  terminalWslDistro,
} from './terminalFileLinks'
import { afterEach, test, vi } from 'vitest'

// A path long enough to reach the next row, in the two ways it gets there.
//
// A SOFT wrap is xterm's: the row ran out of columns and the next one carries
// `isWrapped`. A HARD wrap is the program's: an agent CLI lays out its own
// frame and breaks a long path onto the next row with a newline, usually
// indented to its paragraph margin or behind a frame rule, so the buffer holds
// two unrelated rows. Clicking either half of a hard-wrapped path used to open
// whichever fragment that row held on its own, and report it missing.
//
// Every case runs on a real xterm buffer built from the options the live panes
// use, written the way a program would write it.

const live: Terminal[] = []

afterEach(() => {
  for (const terminal of live.splice(0)) terminal.dispose()
})

async function terminalWith(cols: number, output: string): Promise<XtermTerminal> {
  const terminal = new Terminal({ ...TERMINAL_CELL_GEOMETRY_OPTIONS, cols, rows: 12, scrollback: 100 })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION
  live.push(terminal)
  await new Promise<void>((resolve) => terminal.write(output, () => resolve()))
  return terminal as unknown as XtermTerminal
}

type Activation = { resolvedPath: string; line?: number; column?: number }

type Pane = {
  linksAt: (row: number) => Promise<ILink[]>
  click: (link: ILink) => Promise<Activation | string>
  inspected: string[]
}

/** A provider over `terminal` whose file system holds exactly `existing`. */
function paneOver(
  terminal: XtermTerminal,
  existing: string[],
  roots: { workspaceRoot?: string | null; executionRoot?: string | null; wslDistro?: string | null } = {},
): Pane {
  const inspected: string[] = []
  const outcomes: Array<Activation | string> = []
  const provider = createTerminalFileLinkProvider({
    terminal,
    workspaceRoot: roots.workspaceRoot ?? '/Users/dev/project',
    executionRoot: roots.executionRoot ?? null,
    wslDistro: roots.wslDistro ?? null,
    inspectPath: async (path) => {
      inspected.push(path)
      return { exists: existing.includes(path), isDirectory: false }
    },
    onActivate: ({ resolvedPath, line, column }) => {
      outcomes.push({ resolvedPath, line, column })
    },
    onOpenError: (message) => {
      outcomes.push(message)
    },
  })
  return {
    inspected,
    linksAt: (row) => new Promise((resolve) => provider.provideLinks(row, (links) => resolve(links ?? []))),
    click: async (link) => {
      const before = outcomes.length
      link.activate({ clientX: 0, clientY: 0 } as MouseEvent, link.text)
      for (let tick = 0; tick < 10 && outcomes.length === before; tick += 1) await Promise.resolve()
      return outcomes.at(-1) ?? 'no outcome'
    },
  }
}

test('a soft-wrapped path is one link from either row, and opens at its line', async () => {
  const path = '/Users/dev/project/src/components/panels/TerminalView.tsx'
  const terminal = await terminalWith(40, `Error in ${path}:274:7 here`)
  assert.equal(terminal.buffer.active.getLine(1)?.isWrapped, true, 'the fixture must actually soft-wrap')
  const pane = paneOver(terminal, [path])

  for (const row of [1, 2]) {
    const links = await pane.linksAt(row)
    assert.equal(links.length, 1)
    assert.equal(links[0]?.text, `${path}:274:7`)
    assert.deepEqual(links[0]?.range, { start: { x: 10, y: 1 }, end: { x: 32, y: 2 } })
    assert.deepEqual(await pane.click(links[0]!), { resolvedPath: path, line: 274, column: 7 })
  }
  // Exact by construction: nothing to confirm on disk until the click.
  assert.deepEqual(pane.inspected, [path, path])
})

test('a path an agent CLI hard-wrapped onto an indented row is one link from either row', async () => {
  // The CLI's message column stops a column short of the terminal's edge and
  // hangs the rest of the paragraph two spaces in, as a newline.
  const cols = 51
  const head = '⏺ Updated /home/dev/project/src/components/panels/'
  const tail = '  TerminalView.tsx with the fix.'
  assert.equal(head.length, cols - 1)
  const path = '/home/dev/project/src/components/panels/TerminalView.tsx'
  const terminal = await terminalWith(cols, `${head}\r\n${tail}`)
  assert.equal(terminal.buffer.active.getLine(1)?.isWrapped, false, 'the fixture must be a hard wrap')
  const pane = paneOver(terminal, [path])

  for (const row of [1, 2]) {
    const links = await pane.linksAt(row)
    assert.equal(links.length, 1, `row ${row}`)
    assert.equal(links[0]?.text, path)
    assert.deepEqual(links[0]?.range, { start: { x: 11, y: 1 }, end: { x: 18, y: 2 } })
    assert.deepEqual(await pane.click(links[0]!), { resolvedPath: path, line: undefined, column: undefined })
  }
})

test('a path wrapped inside a framed box joins across the frame rules', async () => {
  const cols = 44
  const rows = [
    '╭──────────────────────────────────────────╮',
    '│ Read src/renderer/src/components/panels/ │',
    '│ TerminalView.tsx                         │',
    '╰──────────────────────────────────────────╯',
  ]
  assert.ok(rows.every((row) => row.length === cols))
  const terminal = await terminalWith(cols, rows.join('\r\n'))
  const path = '/Users/dev/project/src/renderer/src/components/panels/TerminalView.tsx'
  const pane = paneOver(terminal, [path])

  for (const row of [2, 3]) {
    const links = await pane.linksAt(row)
    assert.equal(links.length, 1, `row ${row}`)
    assert.equal(links[0]?.text, 'src/renderer/src/components/panels/TerminalView.tsx')
    // From the path's first cell to its last: xterm underlines a range whole,
    // so the frame rules between the halves are under the line too.
    assert.deepEqual(links[0]?.range, { start: { x: 8, y: 2 }, end: { x: 18, y: 3 } })
    assert.deepEqual(await pane.click(links[0]!), { resolvedPath: path, line: undefined, column: undefined })
  }
})

test('a line and column suffix split by the wrap still reaches the click', async () => {
  const path = '/Users/dev/project/src/app/main.ts'
  // Cut inside the suffix, and cut exactly before it.
  for (const [head, tail, line, column] of [
    [`  at ${path}:1`, '  2:7 in main()', 12, 7],
    [`  at ${path}`, '  :42:3 in main()', 42, 3],
  ] as const) {
    const terminal = await terminalWith(head.length, `${head}\r\n${tail}`)
    const pane = paneOver(terminal, [path])
    for (const row of [1, 2]) {
      const links = await pane.linksAt(row)
      assert.equal(links.length, 1, `${head} row ${row}`)
      assert.equal(links[0]?.text, `${path}:${line}:${column}`)
      assert.deepEqual(await pane.click(links[0]!), { resolvedPath: path, line, column })
    }
  }
})

test('a path hard-wrapped with no indent, as a re-rendering Windows pty does, joins at the edge', async () => {
  const head = 'C:\\Users\\dev\\project\\src\\components\\'
  const terminal = await terminalWith(head.length, `${head}\r\nButton.tsx:9 failed`)
  const path = 'C:\\Users\\dev\\project\\src\\components\\Button.tsx'
  const pane = paneOver(terminal, [path], { workspaceRoot: 'C:\\Users\\dev\\project' })
  const links = await pane.linksAt(2)
  assert.equal(links.length, 1)
  assert.deepEqual(await pane.click(links[0]!), { resolvedPath: path, line: 9, column: undefined })
})

test('a path across three rows is joined from its middle row too', async () => {
  const cols = 25
  const rows = ['  /Users/dev/project/src/', '  components/panels/Term', '  inalView.tsx:3 ok']
  const terminal = await terminalWith(cols, rows.join('\r\n'))
  const path = '/Users/dev/project/src/components/panels/TerminalView.tsx'
  const pane = paneOver(terminal, [path])
  for (const row of [1, 2, 3]) {
    const links = await pane.linksAt(row)
    assert.equal(links.length, 1, `row ${row}`)
    assert.equal(links[0]?.text, `${path}:3`)
    assert.deepEqual(links[0]?.range, { start: { x: 3, y: 1 }, end: { x: 16, y: 3 } })
  }
})

test('two unrelated paths on adjacent rows are not joined unless the joined path exists', async () => {
  const head = '  src/components/Button.tsx'
  const output = `${head}\r\n  src/components/Card.tsx`
  const terminal = await terminalWith(head.length, output)
  const button = '/Users/dev/project/src/components/Button.tsx'
  const card = '/Users/dev/project/src/components/Card.tsx'
  const pane = paneOver(terminal, [button, card])

  const first = await pane.linksAt(1)
  assert.deepEqual(
    first.map((link) => link.text),
    ['src/components/Button.tsx'],
  )
  const second = await pane.linksAt(2)
  assert.deepEqual(
    second.map((link) => link.text),
    ['src/components/Card.tsx'],
  )
  // The guess was asked about, and turned down.
  assert.ok(pane.inspected.includes('/Users/dev/project/src/components/Button.tsxsrc/components/Card.tsx'))
  assert.deepEqual(await pane.click(second[0]!), { resolvedPath: card, line: undefined, column: undefined })
})

test('a path that ends mid-row is complete, and the row below is never consulted', async () => {
  const terminal = await terminalWith(60, 'See src/a/b.json\r\n    src/c/d.json also')
  const pane = paneOver(terminal, [])
  assert.deepEqual(
    (await pane.linksAt(1)).map((link) => link.text),
    ['src/a/b.json'],
  )
  assert.deepEqual(pane.inspected, [])
})

test('prose that runs to the edge is never joined into a path', async () => {
  const head = 'The plan covers the gate reset path and the proposed'
  const terminal = await terminalWith(head.length, `${head}\r\n    publish-id/gate-retention model`)
  const pane = paneOver(terminal, [])
  assert.deepEqual(await pane.linksAt(1), [])
  // The row below keeps its own match.
  assert.deepEqual(
    (await pane.linksAt(2)).map((link) => link.text),
    ['publish-id/gate-retention'],
  )
  // Asked about, and turned down: nothing by that name exists.
  assert.deepEqual([...new Set(pane.inspected)], ['/Users/dev/project/proposedpublish-id/gate-retention'])
})

test('a URL is left to the web-link provider, wrapped either way', async () => {
  const url = 'https://example.com/docs/guides/terminal/links.md'
  const soft = await terminalWith(30, `Docs: ${url}`)
  const softPane = paneOver(soft, [])
  assert.deepEqual(await softPane.linksAt(1), [])
  assert.deepEqual(await softPane.linksAt(2), [])

  // Hard-wrapped, the tail row reads like a relative path on its own.
  const head = `  Docs: ${url.slice(0, 30)}`
  const hard = await terminalWith(head.length, `${head}\r\n  ${url.slice(30)}`)
  const hardPane = paneOver(hard, [])
  assert.deepEqual(await hardPane.linksAt(1), [])
  assert.deepEqual(await hardPane.linksAt(2), [])
})

test('a missing joined path falls back to what the row says on its own', async () => {
  const head = '  /Users/dev/project/src/components/'
  const terminal = await terminalWith(head.length, `${head}\r\n  Gone.tsx`)
  const pane = paneOver(terminal, [])
  const links = await pane.linksAt(1)
  assert.deepEqual(
    links.map((link) => link.text),
    ['/Users/dev/project/src/components/'],
  )
})

test('a Linux path printed under WSL opens through the distribution share', () => {
  const share = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\project'
  const roots = { workspaceRoot: share, executionRoot: null, wslDistro: 'Ubuntu' }
  assert.equal(
    resolveTerminalFileReferencePath('/home/dev/project/src/app.ts', roots),
    '\\\\wsl.localhost\\Ubuntu\\home\\dev\\project\\src\\app.ts',
  )
  // A relative path joins onto the share, and keeps it a share.
  assert.equal(
    resolveTerminalFileReferencePath('src/../lib/app.ts', roots),
    '\\\\wsl.localhost\\Ubuntu\\home\\dev\\project\\lib\\app.ts',
  )
  // A shell's cwd reported the Linux way still lands on the share.
  assert.equal(
    resolveTerminalFileReferencePath('src/app.ts', { ...roots, executionRoot: '/home/dev/project' }),
    '\\\\wsl.localhost\\Ubuntu\\home\\dev\\project\\src\\app.ts',
  )
  // A folder on a Windows drive, with the distribution named by the pane.
  const drive = { workspaceRoot: 'C:\\Users\\dev\\project', executionRoot: null }
  assert.equal(
    resolveTerminalFileReferencePath('/home/dev/.config/app.json', { ...drive, wslDistro: 'Ubuntu' }),
    '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.config\\app.json',
  )
  // A drive mount needs no distribution.
  assert.equal(
    resolveTerminalFileReferencePath('/mnt/c/Users/dev/project/src/app.ts', drive),
    'C:\\Users\\dev\\project\\src\\app.ts',
  )
  // A `..` stops at the share, as it stops at a drive.
  assert.equal(
    resolveTerminalFileReferencePath('../../../../../etc/hosts', roots),
    '\\\\wsl.localhost\\Ubuntu\\etc\\hosts',
  )
  // macOS and Linux hosts are untouched.
  assert.equal(
    resolveTerminalFileReferencePath('/home/dev/project/src/app.ts', { workspaceRoot: '/Users/dev/project' }),
    '/home/dev/project/src/app.ts',
  )
})

test('a hard-wrapped WSL path is confirmed and opened through the share', async () => {
  const head = '⏺ Updated /home/dev/project/src/components/'
  const terminal = await terminalWith(head.length + 1, `${head}\r\n  Button.tsx:12`)
  const opened = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\project\\src\\components\\Button.tsx'
  const pane = paneOver(terminal, [opened], {
    workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\project',
    wslDistro: 'Ubuntu',
  })
  const links = await pane.linksAt(2)
  assert.equal(links.length, 1)
  assert.deepEqual(await pane.click(links[0]!), { resolvedPath: opened, line: 12, column: undefined })
})

test('the distribution comes from the launch, then from a share, and only on Windows', () => {
  const share = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\project'
  assert.equal(terminalWslDistro({ platform: 'win32', hostId: 'wsl:Debian', roots: [share] }), 'Debian')
  assert.equal(terminalWslDistro({ platform: 'win32', hostId: 'local', roots: [null, share] }), 'Ubuntu')
  assert.equal(terminalWslDistro({ platform: 'win32', roots: ['C:\\Users\\dev\\project'] }), null)
  // Another machine's workspace, stored under a share, viewed from a Mac.
  assert.equal(terminalWslDistro({ platform: 'darwin', hostId: 'wsl:Ubuntu', roots: [share] }), null)
})

test('a path on the row after wrapped prose is joined from where it starts', async () => {
  // The CLI wraps the sentence to the same edge the path is cut at, so the
  // sentence's last word sits right against the head of the path.
  const rows = ['I updated the provider in the file at', '  /Users/dev/project/src/components/pan', '  els/App.tsx now']
  const terminal = await terminalWith(40, rows.join('\r\n'))
  const path = '/Users/dev/project/src/components/panels/App.tsx'
  const pane = paneOver(terminal, [path])
  for (const row of [2, 3]) {
    const links = await pane.linksAt(row)
    assert.deepEqual(
      links.map((link) => link.text),
      [path],
      `row ${row}`,
    )
    assert.deepEqual(links[0]?.range, { start: { x: 3, y: 2 }, end: { x: 13, y: 3 } })
  }

  // And a relative one, where the glued guess is just as plausible-looking.
  const relative = await terminalWith(
    40,
    [
      'Then I read the whole of the module in the',
      '  src/renderer/src/components/panels/Ter',
      '  minalView.tsx:12',
    ].join('\r\n'),
  )
  const relativePath = '/Users/dev/project/src/renderer/src/components/panels/TerminalView.tsx'
  const relativePane = paneOver(relative, [relativePath])
  const links = await relativePane.linksAt(3)
  assert.deepEqual(
    links.map((link) => link.text),
    ['src/renderer/src/components/panels/TerminalView.tsx:12'],
  )
  assert.deepEqual(await relativePane.click(links[0]!), { resolvedPath: relativePath, line: 12, column: undefined })
})

test('a framed row joins onto the row below only when the joined path exists', async () => {
  const rows = ['│ see /Users/dev/project/src/ │', 'components/App.tsx']
  const terminal = await terminalWith(60, rows.join('\r\n'))
  const pane = paneOver(terminal, ['/Users/dev/project/src/components/App.tsx'])
  // The frame closes far from the terminal's edge, so the rule IS the edge,
  // and the head reaches it — the join is only kept because the file exists.
  const links = await pane.linksAt(2)
  assert.deepEqual(
    links.map((link) => link.text),
    ['/Users/dev/project/src/components/App.tsx'],
  )
  // Without that file, each row keeps its own match.
  const bare = paneOver(terminal, [])
  assert.deepEqual(
    (await bare.linksAt(2)).map((link) => link.text),
    ['components/App.tsx'],
  )
  assert.deepEqual(
    (await bare.linksAt(1)).map((link) => link.text),
    ['/Users/dev/project/src/'],
  )
})

test('a hard-wrapped path after wide characters lands on the right cells', async () => {
  // Three CJK characters are six columns and three code units.
  const head = '日本語 /Users/dev/project/src/'
  const terminal = await terminalWith(30, `${head}\r\n  components/A.tsx`)
  const path = '/Users/dev/project/src/components/A.tsx'
  const pane = paneOver(terminal, [path])
  const links = await pane.linksAt(2)
  assert.equal(links.length, 1)
  assert.deepEqual(links[0]?.range, { start: { x: 8, y: 1 }, end: { x: 18, y: 2 } })
  assert.equal(terminal.buffer.active.getLine(0)?.getCell(7)?.getChars(), '/')
})

test('an answer for a row the pointer has left is dropped, not filed under the new row', async () => {
  const head = '  /Users/dev/project/src/components/'
  const terminal = await terminalWith(head.length, `${head}\r\n  App.tsx\r\n\r\nplain row src/a/b.ts`)
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const answers: Array<{ row: number; links: ILink[] | undefined }> = []
  const provider = createTerminalFileLinkProvider({
    terminal,
    workspaceRoot: '/Users/dev/project',
    inspectPath: async () => {
      await gate
      return { exists: true, isDirectory: false }
    },
    onActivate: () => {},
  })
  provider.provideLinks(1, (links) => answers.push({ row: 1, links }))
  provider.provideLinks(4, (links) => answers.push({ row: 4, links }))
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(
    answers.map((answer) => answer.row),
    [4],
  )
})

test('a check that never answers does not hold the row past its deadline', async () => {
  const head = '  /Users/dev/project/src/components/'
  const terminal = await terminalWith(head.length, `${head}\r\n  App.tsx`)
  vi.useFakeTimers()
  try {
    const answers: Array<ILink[] | undefined> = []
    createTerminalFileLinkProvider({
      terminal,
      workspaceRoot: '/Users/dev/project',
      inspectPath: () => new Promise(() => {}),
      onActivate: () => {},
    }).provideLinks(1, (links) => {
      answers.push(links)
    })
    assert.equal(answers.length, 0)
    await vi.advanceTimersByTimeAsync(1_000)
    // What the row says on its own.
    assert.deepEqual(
      answers.map((links) => links?.map((link) => link.text)),
      [['/Users/dev/project/src/components/']],
    )
  } finally {
    vi.useRealTimers()
  }
})
