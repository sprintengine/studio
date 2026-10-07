// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { drawDiagram, LOADS_FROM_ELSEWHERE } from './mermaidDiagram'

// The real renderer, not a stand-in: what matters is what Mermaid adds to the
// page while it measures a diagram, before anything of ours sees the SVG.
// jsdom does no layout, so every box measures the same; that is enough to lay
// a small diagram out.

beforeAll(() => {
  const svg = window.SVGElement.prototype as unknown as Record<string, unknown>
  svg.getBBox = () => ({ x: 0, y: 0, width: 40, height: 16 })
  svg.getComputedTextLength = () => 40
})

// Every element added to the page while a diagram is drawn, and every one
// whose attributes or text change after it was.
let mounted: Set<Element>
let observer: MutationObserver

beforeEach(() => {
  mounted = new Set()
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof Element) mounted.add(record.target)
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        mounted.add(node)
        for (const inner of node.querySelectorAll('*')) mounted.add(inner)
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
})

afterEach(() => observer.disconnect())

async function drawnWhileWatched(source: string) {
  const result = await drawDiagram('light', source)
  // Mutation records are delivered a turn later.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { result, onPage: [...mounted].map((element) => element.outerHTML).join('\n') }
}

test('a diagram cannot turn labels back into HTML or add CSS of its own, even while it is measured', async () => {
  const source = [
    '%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}, "themeCSS": ".planted-rule { fill: red }", "fontFamily": "planted-font"}}%%',
    'graph TD',
    '  A["<img src=https://evil.example/c.png> hi"] --> B',
  ].join('\n')
  const { result, onPage } = await drawnWhileWatched(source)
  expect(result).toMatchObject({ svg: expect.stringContaining('<svg') })
  const { svg } = result as { svg: string }

  // The label is SVG text, and the `<img>` in it is gone before it is
  // measured: never an element, on the page or in the drawing.
  expect(onPage).toContain('>hi<')
  expect(svg).toContain('>hi<')
  expect(onPage).not.toMatch(/<img|<foreignObject|evil\.example/iu)
  expect(svg).not.toMatch(/<img|<foreignObject|evil\.example/iu)

  // The directive's CSS and font reached neither the page nor the drawing.
  expect(onPage).not.toMatch(/planted-rule|planted-font/u)
  expect(svg).not.toMatch(/planted-rule|planted-font/u)
})

test('a diagram whose styles load from elsewhere is never handed to the renderer', async () => {
  const source = 'classDiagram\n  class A\n  style A fill:url(https://evil.example/d.png)'
  const { result, onPage } = await drawnWhileWatched(source)
  expect(result).toEqual({ error: LOADS_FROM_ELSEWHERE })
  expect(onPage).not.toContain('evil.example')
})

test('an ordinary diagram still draws, its markers pointing at themselves', async () => {
  const { result } = await drawnWhileWatched('graph TD\n  Start --> Finish')
  const { svg } = result as { svg: string }
  expect(svg).toContain('Start')
  expect(svg).toMatch(/marker-end="url\(#[^"]+\)"/u)
})
