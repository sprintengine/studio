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
