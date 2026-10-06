// @vitest-environment jsdom
import DOMPurify from 'dompurify'
import { beforeEach, expect, test, vi } from 'vitest'

// Mermaid needs a real layout engine to measure its labels, so the renderer is
// a stand-in that records the order it is driven in. Its `render` waits a turn
// before answering, so two diagrams drawn at once would interleave if nothing
// kept them apart.
const mermaid = vi.hoisted(() => {
  const events: string[] = []
  const configs: Array<Record<string, unknown>> = []
  return {
    events,
    configs,
    api: {
      initialize: (config: Record<string, unknown>) => {
        configs.push(config)
        events.push('initialize')
      },
      parse: async (source: string) => {
        if (source.includes('broken')) throw new Error('Parse error on line 2:\n...\nExpecting NODE_STRING')
        return { diagramType: 'flowchart' }
      },
      render: async (id: string, source: string) => {
        events.push(`start ${source}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        events.push(`end ${source}`)
        return { svg: `<svg id="${id}"><text>${source}</text></svg>` }
      },
    },
  }
})
vi.mock('mermaid', () => ({ default: mermaid.api }))

const { appearanceKey, cachedDiagram, drawDiagram, sanitizeDiagramSvg } = await import('./mermaidDiagram')

beforeEach(() => {
  mermaid.events.length = 0
  mermaid.configs.length = 0
})

test('diagrams are drawn one at a time, each under the configuration it was drawn with', async () => {
  const [first, second] = await Promise.all([drawDiagram('a', 'graph TD; one'), drawDiagram('a', 'graph TD; two')])
  expect(mermaid.events).toEqual([
    'initialize',
    'start graph TD; one',
    'end graph TD; one',
    'initialize',
    'start graph TD; two',
    'end graph TD; two',
  ])
  expect(first).toMatchObject({ svg: expect.stringContaining('graph TD; one') })
  expect(second).toMatchObject({ svg: expect.stringContaining('graph TD; two') })
  for (const config of mermaid.configs) {
    expect(config).toMatchObject({ securityLevel: 'strict', theme: 'base', startOnLoad: false })
  }
})

test('a diagram is drawn once per appearance and source, however often it is asked for', async () => {
  const asked = await Promise.all([drawDiagram('light', 'graph LR; cached'), drawDiagram('light', 'graph LR; cached')])
  expect(asked[0]).toBe(asked[1])
  expect(mermaid.events.filter((event) => event.startsWith('start'))).toHaveLength(1)
  expect(cachedDiagram('light', 'graph LR; cached')).toBe(asked[0])
  expect(await drawDiagram('light', 'graph LR; cached')).toBe(asked[0])
  expect(mermaid.events.filter((event) => event.startsWith('start'))).toHaveLength(1)

  // Another appearance is another drawing: its colours are baked into the SVG.
  expect(cachedDiagram('dark', 'graph LR; cached')).toBeUndefined()
  await drawDiagram('dark', 'graph LR; cached')
  expect(mermaid.events.filter((event) => event.startsWith('start'))).toHaveLength(2)
})

test('a source that does not parse resolves to its error, is never drawn, and is not parsed again', async () => {
  const result = await drawDiagram('a', 'graph TD\n  broken -->')
  expect(result).toEqual({ error: expect.stringContaining('Parse error on line 2') })
  expect(mermaid.events).toEqual(['initialize'])
  await drawDiagram('a', 'graph TD\n  broken -->')
  expect(mermaid.events).toEqual(['initialize'])
})

test('the appearance is the theme and the mode the document root carries', () => {
  document.documentElement.setAttribute('data-theme', 'paper')
  document.documentElement.setAttribute('data-mode', 'light')
  expect(appearanceKey()).toBe('paper|light')
})

test('the SVG keeps its drawing and labels and loses anything that could run', () => {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">',
    '<style>#d .node rect{fill:#eee}</style>',
    '<script>alert(2)</script>',
    '<a href="javascript:alert(3)"><rect width="4" height="4"/></a>',
    '<g class="label"><foreignObject width="40" height="20">',
    '<div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Start</p></span>',
    '<img src="x" onerror="alert(4)"></div>',
    '</foreignObject></g>',
    '<path d="M0 0L10 10" marker-end="url(#d_arrow)"/>',
    '</svg>',
  ].join('')
  const clean = sanitizeDiagramSvg(DOMPurify, svg)
  expect(clean).not.toMatch(/onload|onerror|<script|javascript:/u)
  expect(clean).toContain('<style>')
  expect(clean).toContain('<foreignObject')
  expect(clean).toContain('<p>Start</p>')
  expect(clean).toContain('marker-end="url(#d_arrow)"')
})
