// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// Mermaid needs a real layout engine, so the renderer is a stand-in that
// draws a recognisable SVG and counts what it is asked to draw.
const mermaid = vi.hoisted(() => {
  const drawn: string[] = []
  return {
    drawn,
    api: {
      initialize: () => undefined,
      parse: async (source: string) => {
        if (source.includes('-->>>')) throw new Error('Parse error on line 2:\n...\nExpecting NODE_STRING')
        return { diagramType: 'flowchart' }
      },
      // The parsed diagram, read for what it would load: nothing here.
      mermaidAPI: { getDiagramFromText: async () => ({ db: {} }) },
      render: async (id: string, source: string) => {
        drawn.push(source)
        return { svg: `<svg id="${id}" data-diagram=""><text>${source.split('\n')[1]?.trim()}</text></svg>` }
      },
    },
  }
})
vi.mock('mermaid', () => ({ default: mermaid.api }))

const { ConversationMarkdown } = await import('./conversationLinks')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  mermaid.drawn.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

// Until `ready` holds: a module graph imported afresh takes longer than a few turns.
async function settleUntil(ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !ready(); turn++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
  }
}

const diagram = (label: string) => `\`\`\`mermaid\ngraph TD\n  ${label} --> B\n\`\`\``

test('a reply draws its mermaid block only once the message has settled', async () => {
  // The fence has closed, but the message is still streaming.
  const source = `Here is the flow:\n\n${diagram('Streamed')}`
  act(() => root.render(<ConversationMarkdown text={source} streaming />))
  await settle()
  expect(mermaid.drawn).toEqual([])
  expect(container.querySelector('[data-diagram]')).toBeNull()
  expect(container.querySelector('pre')?.textContent).toContain('Streamed --> B')

  act(() => root.render(<ConversationMarkdown text={source} />))
  await settle()
  expect(mermaid.drawn).toHaveLength(1)
  const drawing = container.querySelector('.ds-code-block__drawing')
  expect(drawing?.querySelector('[data-diagram]')?.textContent).toBe('Streamed --> B')
  // The source is still the block's text, for Copy code and a copied selection.
  expect(drawing?.hasAttribute('data-copy-exclude')).toBe(true)
  const body = container.querySelector('.ds-code-block__body')
  expect(body?.hasAttribute('hidden')).toBe(true)
  expect(body?.querySelector('pre')?.textContent).toContain('Streamed --> B')
  expect(container.querySelector('[data-code-language="mermaid"]')).not.toBeNull()
})

test('the same diagram shown twice is drawn once, and each copy has ids of its own', async () => {
  act(() => root.render(<ConversationMarkdown text={`${diagram('Twice')}\n\nAgain:\n\n${diagram('Twice')}`} />))
  await settleUntil(() => container.querySelectorAll('[data-diagram]').length === 2)
  expect(mermaid.drawn).toHaveLength(1)
  const ids = [...container.querySelectorAll('[data-diagram]')].map((svg) => svg.id)
  expect(ids).toHaveLength(2)
  expect(ids[0]).not.toBe(ids[1])
})

test('Show source swaps the drawing for its source and back', async () => {
  act(() => root.render(<ConversationMarkdown text={diagram('Toggle')} />))
  await settle()
  const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Show source"]')
  expect(toggle?.getAttribute('aria-pressed')).toBe('false')
  expect(container.querySelector('button[aria-label="Copy code"]')).not.toBeNull()

  act(() => toggle?.click())
  expect(container.querySelector('.ds-code-block__drawing')).toBeNull()
  expect(container.querySelector('.ds-code-block__body')?.hasAttribute('hidden')).toBe(false)
  expect(toggle?.getAttribute('aria-pressed')).toBe('true')

  act(() => toggle?.click())
  expect(container.querySelector('.ds-code-block__drawing [data-diagram]')).not.toBeNull()
})

test('a diagram that does not parse stays its source, with a note saying why', async () => {
  act(() => root.render(<ConversationMarkdown text={'```mermaid\ngraph TD\n  A -->>> B\n```'} />))
  await settle()
  expect(container.querySelector('.ds-code-block__drawing')).toBeNull()
  expect(container.querySelector('button[aria-label="Show source"]')).toBeNull()
  expect(container.querySelector('pre')?.textContent).toContain('A -->>> B')
  expect(container.querySelector('.ds-code-block__note')?.textContent).toBe('Shown as source: Parse error on line 2')
})

test('what a person typed is shown as typed: no diagram, no math', async () => {
  act(() => root.render(<ConversationMarkdown text={`${diagram('Typed')}\n\nIs $$x^2$$ right?`} userText />))
  await settle()
  expect(mermaid.drawn).toEqual([])
  expect(container.querySelector('.ds-code-block__drawing')).toBeNull()
  expect(container.querySelector('[data-math]')).toBeNull()
  expect(container.textContent).toContain('Is $$x^2$$ right?')
})

test('other code blocks in a reply are untouched', async () => {
  act(() => root.render(<ConversationMarkdown text={'```ts\nconst cost = "$5"\n```'} />))
  await settle()
  expect(mermaid.drawn).toEqual([])
  expect(container.querySelector('button[aria-label="Show source"]')).toBeNull()
  expect(container.querySelector('pre')?.textContent).toContain('const cost = "$5"')
})

test('an appearance switch redraws the diagram, keeping the old drawing up meanwhile', async () => {
  document.documentElement.setAttribute('data-mode', 'light')
  act(() => root.render(<ConversationMarkdown text={diagram('Themed')} />))
  await settle()
  expect(mermaid.drawn).toHaveLength(1)

  act(() => document.documentElement.setAttribute('data-mode', 'dark'))
  expect(container.querySelector('.ds-code-block__drawing [data-diagram]')).not.toBeNull()
  await settle()
  expect(mermaid.drawn).toHaveLength(2)
  expect(container.querySelector('.ds-code-block__drawing [data-diagram]')).not.toBeNull()
})

test('a renderer that did not load says so, and Retry asks for it again', async () => {
  vi.resetModules()
  vi.doMock('mermaid', () => {
    throw new Error('Failed to fetch dynamically imported module')
  })
  const fresh = await import('./conversationLinks')
  act(() => root.render(<fresh.ConversationMarkdown text={diagram('Offline')} />))
  await settleUntil(() => container.querySelector('.ds-code-block__note') !== null)
  const note = container.querySelector('.ds-code-block__note')
  expect(note?.textContent).toBe('Shown as source: The diagram renderer could not be loaded · Retry')
  expect(container.querySelector('pre')?.textContent).toContain('Offline --> B')

  vi.doMock('mermaid', () => ({ default: mermaid.api }))
  const retry = [...(note?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Retry')
  act(() => retry?.click())
  await settleUntil(() => container.querySelector('.ds-code-block__drawing') !== null)
  expect(container.querySelector('.ds-code-block__drawing [data-diagram]')?.textContent).toBe('Offline --> B')
  expect(container.querySelector('.ds-code-block__note')).toBeNull()
  vi.doUnmock('mermaid')
})
