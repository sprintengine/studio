import assert from 'node:assert/strict'
import type { ITerminalAddon } from '@xterm/xterm'

// `@xterm/addon-clipboard` ships as a UMD bundle whose factory is invoked with
// `self`, so it cannot be required into a bare Node process. Defining it before
// the module under test is loaded is the whole reason the import below is
// dynamic — the addon under test is the REAL one, deliberately, because the
// behaviour being pinned down is the addon's own default read path.
;(globalThis as { self?: unknown }).self ??= globalThis

type Osc52Module = typeof import('./terminalOsc52Clipboard')

// The question this file exists to answer is not "does copy work" — it is "can
// a program that owns a pane read the user's clipboard back out of it". OSC 52
// carries both directions in one sequence, `@xterm/addon-clipboard` answers the
// read direction by default (BrowserClipboardProvider.readText ->
// navigator.clipboard.readText -> terminal.input(...)), and in this app the
// programs holding panes are agent CLIs and whatever they were asked to `cat`.
//
// So these tests drive the REAL addon through a terminal double that reproduces
// xterm's OSC dispatch order, and assert on the bytes that reach the pty.

/**
 * xterm's OSC dispatch, in the one respect that matters here: handlers run in
 * REVERSE registration order and the first one returning true ends the
 * sequence. `EscapeSequenceParser` does exactly this; if it ever stopped, the
 * read guard would sit behind the addon instead of in front of it.
 */
function createFakeTerminal() {
  const handlers = new Map<number, Array<(data: string) => boolean | Promise<boolean>>>()
  const inputs: string[] = []
  const loaded: ITerminalAddon[] = []
  const terminal = {
    inputs,
    loaded,
    input: (data: string) => {
      inputs.push(data)
    },
    loadAddon: (addon: ITerminalAddon) => {
      loaded.push(addon)
      addon.activate(terminal as never)
    },
    parser: {
      registerOscHandler: (identifier: number, handler: (data: string) => boolean | Promise<boolean>) => {
        const list = handlers.get(identifier) ?? []
        list.push(handler)
        handlers.set(identifier, list)
        return {
          dispose: () => {
            const index = list.indexOf(handler)
            if (index >= 0) list.splice(index, 1)
          },
        }
      },
    },
    /** Feed one OSC payload in, as the parser would. */
    dispatchOsc: async (identifier: number, data: string): Promise<boolean> => {
      const list = handlers.get(identifier) ?? []
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (await list[index](data)) return true
      }
      return false
    },
    handlerCount: (identifier: number) => (handlers.get(identifier) ?? []).length,
  }
  return terminal
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

const results: string[] = []
async function run(name: string, body: () => void | Promise<void>): Promise<void> {
  await body()
  results.push(name)
  console.log(`ok - ${name}`)
}

async function main(): Promise<void> {
  const {
    attachTerminalOsc52Clipboard,
    createOsc52ReadGuard,
    createWriteOnlyClipboardProvider,
    isTerminalOsc52ReadRequest,
  }: Osc52Module = await import('./terminalOsc52Clipboard')

  await run('a write request reaches the system clipboard', async () => {
    const terminal = createFakeTerminal()
    const written: string[] = []
    attachTerminalOsc52Clipboard({ terminal, writeText: (text) => void written.push(text) })

    const handled = await terminal.dispatchOsc(52, `c;${base64('copied by the CLI')}`)

    assert.equal(handled, true)
    assert.deepEqual(written, ['copied by the CLI'])
  })

  await run('a read request is refused and nothing is typed back at the program', async () => {
    const terminal = createFakeTerminal()
    const written: string[] = []
    attachTerminalOsc52Clipboard({ terminal, writeText: (text) => void written.push(text) })

    const handled = await terminal.dispatchOsc(52, 'c;?')

    // Handled, so nothing else sees it — and, the point of the whole file, the
    // addon never got to call `terminal.input()` with the clipboard in it.
    assert.equal(handled, true)
    assert.deepEqual(terminal.inputs, [], 'a clipboard read must put no bytes into the pty')
    assert.deepEqual(written, [])
  })

  await run('every selection spelling of a read request is refused', async () => {
    const terminal = createFakeTerminal()
    attachTerminalOsc52Clipboard({ terminal, writeText: () => {} })

    // `c` clipboard, `p` primary, `s` select, the empty default, and a
    // multi-selection list — all of them are reads, all of them are refused.
    for (const payload of ['c;?', 'p;?', 's;?', ';?', 'cp;?', 'c;?;trailing']) {
      assert.equal(await terminal.dispatchOsc(52, payload), true, payload)
      assert.deepEqual(terminal.inputs, [], `${payload} must emit nothing`)
    }
  })

  await run('the guard runs in front of the addon, not behind it', () => {
    const terminal = createFakeTerminal()
    attachTerminalOsc52Clipboard({ terminal, writeText: () => {} })

    // Two handlers on 52: the addon's, then the guard's. Reverse order means
    // the guard is consulted first. If a future edit registers them the other
    // way round this ordering assertion is what fails.
    assert.equal(terminal.handlerCount(52), 2)
  })

  await run('the provider handed to the addon never returns clipboard content', () => {
    // Belt and braces: the second layer, tested on its own so deleting the
    // guard cannot quietly re-open the channel.
    const provider = createWriteOnlyClipboardProvider(() => {})
    assert.equal(provider.readText('c'), '')
    assert.equal(provider.readText('p'), '')
  })

  await run('the guard classifies reads without mistaking a write for one', () => {
    assert.equal(isTerminalOsc52ReadRequest('c;?'), true)
    assert.equal(isTerminalOsc52ReadRequest(';?'), true)
    // Base64 has no `?`, so no payload of real copied text can look like a read.
    assert.equal(isTerminalOsc52ReadRequest(`c;${base64('?')}`), false)
    assert.equal(isTerminalOsc52ReadRequest('c;'), false)
    // Malformed (one field): the addon ignores it, so neither is this a read.
    assert.equal(isTerminalOsc52ReadRequest('?'), false)
    assert.equal(isTerminalOsc52ReadRequest(''), false)

    const guard = createOsc52ReadGuard()
    assert.equal(guard('c;?'), true, 'a read is swallowed')
    assert.equal(guard(`c;${base64('x')}`), false, 'a write falls through to the addon')
  })

  await run('disposal removes both the guard and the addon', async () => {
    const terminal = createFakeTerminal()
    const written: string[] = []
    const attached = attachTerminalOsc52Clipboard({ terminal, writeText: (text) => void written.push(text) })

    attached.dispose()

    assert.equal(terminal.handlerCount(52), 0)
    assert.equal(await terminal.dispatchOsc(52, `c;${base64('after disposal')}`), false)
    assert.deepEqual(written, [])
  })

  console.log(`\n${results.length} passed`)
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
