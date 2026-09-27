import { test, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolBody, ToolRow } from './ToolRow'
import type { TranscriptToolEntry } from '../conversationProjection'
import { JSDOM } from 'jsdom'

function tool(values: Partial<TranscriptToolEntry>): TranscriptToolEntry {
  return { kind: 'tool', id: 'tool', turnId: 'turn', name: 'Bash', status: 'done', ...values }
}

test('command body retains command, ANSI text, and a neutral nonzero exit status', () => {
  const row = tool({
    toolKind: 'command',
    input: { command: 'rg missing src' },
    output: '\u001b[31mNo matches\u001b[0m',
    exitCode: 1,
  })
  const body = renderToStaticMarkup(<ToolBody tool={row} />)
  expect(body).toContain('rg missing src')
  expect(body).toContain('No matches')
  expect(body).not.toContain('\u001b')
  expect(body).toContain('exit 1')
  expect(renderToStaticMarkup(<ToolRow tool={row} />)).not.toContain('data-tone="error"')
})

test('collapsed file subtitles are independent links, never nested inside the disclosure button', () => {
  const html = renderToStaticMarkup(
    <ToolRow tool={tool({ name: 'Read', toolKind: 'file_read', input: { path: 'src/app.ts' } })} />,
  )
  const document = new JSDOM(html).window.document
  const link = document.querySelector('[aria-label="Open src/app.ts"]')
  expect(link).not.toBeNull()
  expect(link?.parentElement?.closest('button')).toBeNull()
  expect(document.querySelector('button[aria-expanded="false"]')).not.toBeNull()
})

test('read previews, edits, todos, searches, and structured tools have concrete bodies', () => {
  const read = renderToStaticMarkup(
    <ToolBody
      tool={tool({
        toolKind: 'file_read',
        name: 'Read',
        input: { path: 'src/app.ts' },
        output: Array.from({ length: 45 }, (_, i) => `line ${i}`).join('\n'),
      })}
    />,
  )
  expect(read).toContain('Show all')
  expect(read).not.toContain('line 44')
  const edit = renderToStaticMarkup(
    <ToolBody
      tool={tool({
        toolKind: 'file_edit',
        name: 'Edit',
        input: { file_path: 'src/app.ts', old_string: 'old', new_string: 'new' },
      })}
    />,
  )
  expect(edit).toContain('Changes in src/app.ts')
  expect(edit).toContain('+1 −1')
  const todo = renderToStaticMarkup(
    <ToolBody
      tool={tool({
        toolKind: 'todo',
        name: 'TodoWrite',
        input: { todos: [{ content: 'Test changes', status: 'completed' }] },
      })}
    />,
  )
  expect(todo).toContain('Test changes')
  expect(todo).toContain('checked')
  for (const kind of ['search', 'list', 'web', 'mcp', 'other'] as const) {
    expect(
      renderToStaticMarkup(
        <ToolBody tool={tool({ toolKind: kind, name: kind, input: { query: 'lookup' }, output: 'response text' })} />,
      ),
    ).toContain('response text')
  }
})

test('declined tool is explicit and full detail supersedes the persisted snippet', () => {
  expect(renderToStaticMarkup(<ToolBody tool={tool({ outputStatus: 'declined' })} />)).toContain(
    'Tool request declined',
  )
  const full = 'complete output\n'.repeat(4000)
  const markup = renderToStaticMarkup(
    <ToolBody
      tool={tool({ toolKind: 'command', output: 'snippet', truncated: true })}
      detail={{
        input: { command: 'printf output' },
        output: full,
        status: 'ok',
        totalBytes: full.length,
        clipped: false,
      }}
    />,
  )
  expect(markup).toContain('complete output')
  expect(markup).not.toContain('snippet')
  expect(markup.length).toBeGreaterThan(50_000)
})

test('truncated output is fetched only on request and failures can be retried', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  let calls = 0
  const full = 'full output\n'.repeat(5000)
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      conversationToolDetail: async () => {
        if (++calls === 1) throw new Error('Temporarily unavailable')
        return {
          ok: true,
          detail: { input: { command: 'printf output' }, output: full, status: 'ok', totalBytes: full.length },
        }
      },
    },
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ConversationLinkProvider } = await import('../conversationLinks')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const click = (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label)
    expect(button).toBeTruthy()
    button!.click()
  }
  try {
    await act(async () =>
      root.render(
        <ConversationLinkProvider
          workspaceId="tool-detail-test"
          workspaceRoot="/workspace/app"
          cwd="/workspace/app"
          agentId="agent"
        >
          <ToolRow
            tool={tool({
              id: 'large-tool',
              toolKind: 'command',
              input: { command: 'printf output' },
              output: 'snippet',
              truncated: true,
            })}
          />
        </ConversationLinkProvider>,
      ),
    )
    expect(calls).toBe(0)
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
    expect(calls).toBe(0)
    await act(async () => click('Show full output'))
    expect(calls).toBe(1)
    expect(host.textContent).toContain('Temporarily unavailable')
    await act(async () => click('Retry'))
    expect(calls).toBe(2)
    expect(host.textContent).not.toContain('snippet')
    expect(host.textContent!.length).toBeGreaterThan(50_000)
    // The virtualized timeline unmounts a row scrolled out of view; coming back
    // keeps the fetched output without asking for it again.
    const row = (
      <ConversationLinkProvider
        workspaceId="tool-detail-test"
        workspaceRoot="/workspace/app"
        cwd="/workspace/app"
        agentId="agent"
      >
        <ToolRow
          tool={tool({
            id: 'large-tool',
            toolKind: 'command',
            input: { command: 'printf output' },
            output: 'snippet',
            truncated: true,
          })}
        />
      </ConversationLinkProvider>
    )
    await act(async () => root.render(<div />))
    await act(async () => root.render(row))
    expect(calls).toBe(2)
    expect(host.textContent).not.toContain('snippet')
    expect(host.textContent!.length).toBeGreaterThan(50_000)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of [
      'window',
      'document',
      'navigator',
      'HTMLElement',
      'Node',
      'MutationObserver',
      'getComputedStyle',
      'IS_REACT_ACT_ENVIRONMENT',
    ]) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('a running tool shows how long it has been running, a finished one does not', () => {
  const startedAt = Date.now() - 5_000
  const running = renderToStaticMarkup(
    <ToolRow tool={tool({ status: 'running', startedAt, input: { command: 'npm test' } })} />,
  )
  expect(running).toMatch(/>[5-6]s</u)
  const done = renderToStaticMarkup(<ToolRow tool={tool({ startedAt, completedAt: startedAt + 5_000 })} />)
  expect(done).not.toMatch(/>[5-6]s</u)
})

async function withToolDetailDom(
  detail: (toolUseId: string) => { output: string },
  run: (harness: {
    calls: string[]
    show: (row: TranscriptToolEntry) => Promise<void>
    hide: () => Promise<void>
    click: (label: string) => Promise<void>
    expand: () => Promise<void>
    text: () => string
  }) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  const calls: string[] = []
  Object.assign(dom.window, {
    api: {
      platform: 'darwin',
      conversationToolDetail: async ({ toolUseId }: { toolUseId: string }) => {
        calls.push(toolUseId)
        return { ok: true, detail: { input: {}, status: 'ok', clipped: false, ...detail(toolUseId) } }
      },
    },
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ConversationLinkProvider } = await import('../conversationLinks')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const workspaceId = `tool-detail-${Math.random()}`
  try {
    await run({
      calls,
      show: (row) =>
        act(async () =>
          root.render(
            <ConversationLinkProvider
              workspaceId={workspaceId}
              workspaceRoot="/workspace/app"
              cwd="/workspace/app"
              agentId="agent"
            >
              <ToolRow tool={row} />
            </ConversationLinkProvider>,
          ),
        ),
      hide: () => act(async () => root.render(<div />)),
      click: (label) =>
        act(async () => {
          const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label)
          expect(button, label).toBeTruthy()
          button!.click()
        }),
      expand: () =>
        act(async () => {
          host.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
        }),
      text: () => host.textContent ?? '',
    })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

const truncatedCommand = (id: string, values: Partial<TranscriptToolEntry> = {}) =>
  tool({ id, toolKind: 'command', input: { command: 'cat big.log' }, output: 'snippet', truncated: true, ...values })

test('fetched output is cached by size: a few very large outputs push the oldest out', async () => {
  // Three outputs of about 7 MB each in memory; a size budget keeps two.
  const huge = 'x'.repeat(3_500_000)
  await withToolDetailDom(
    () => ({ output: huge }),
    async ({ calls, show, hide, click, expand }) => {
      for (const id of ['first', 'second', 'third']) {
        await show(truncatedCommand(id))
        await expand()
        await click('Show full output')
        await hide()
      }
      expect(calls).toEqual(['first', 'second', 'third'])
      await show(truncatedCommand('third'))
      await hide()
      expect(calls).toHaveLength(3)
      await show(truncatedCommand('first'))
      await click('Show full output')
      expect(calls).toEqual(['first', 'second', 'third', 'first'])
    },
  )
})

test('output fetched while the tool runs is not cached and can be fetched again once it finishes', async () => {
  let version = 0
  await withToolDetailDom(
    () => ({ output: `output v${++version}` }),
    async ({ calls, show, hide, click, expand, text }) => {
      await show(truncatedCommand('live', { status: 'running' }))
      await expand()
      await click('Show full output')
      expect(text()).toContain('output v1')
      await click('Refresh output')
      expect(text()).toContain('output v2')
      await show(truncatedCommand('live'))
      await click('Show final output')
      expect(text()).toContain('output v3')
      expect(calls).toHaveLength(3)
      // Only the finished output is kept for the row's next mount.
      await hide()
      await show(truncatedCommand('live'))
      expect(text()).toContain('output v3')
      expect(calls).toHaveLength(3)
    },
  )
})

test('a tool row whose subject is a folder shows the path as text, never a file chip', () => {
  const html = renderToStaticMarkup(
    <ToolRow tool={tool({ name: 'Read', toolKind: 'file_read', input: { path: '/Users/dev/project' } })} />,
  )
  expect(html).not.toContain('aria-label="Open /Users/dev/project"')
  expect(html).toContain('/Users/dev/project')
})
