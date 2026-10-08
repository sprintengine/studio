// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { drawDiagram, LOADS_FROM_ELSEWHERE, scopeDiagramIds, withoutRemoteImages } from './mermaidDiagram'

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

// Shape data is YAML: a key can be quoted either way, escaped, or follow a
// value holding the brace a text pattern stops at. Each still parses to a node
// with an image, which Mermaid would load to measure while it lays it out.
test.each([
  ['a double-quoted key', 'flowchart TD\n  A@{ "img": "https://evil.example/q1.png" }'],
  ['a single-quoted key', "flowchart TD\n  A@{ 'img': 'https://evil.example/q2.png' }"],
  ['a brace in a value before it', 'flowchart TD\n  A@{ label: "}", img: "https://evil.example/q3.png" }'],
  ['a YAML escape in the key', 'flowchart TD\n  A@{ "\\x69mg": "https://evil.example/q4.png" }'],
])('a node image behind %s is not drawn and never fetched', async (_name, source) => {
  const loads: string[] = []
  const image = window.HTMLImageElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(image, 'src')!
  Object.defineProperty(image, 'src', {
    ...descriptor,
    set(value: string) {
      loads.push(String(value))
      descriptor.set!.call(this, value)
    },
  })
  try {
    const { result, onPage } = await drawnWhileWatched(source)
    expect(result).toEqual({ error: LOADS_FROM_ELSEWHERE })
    expect(onPage).not.toContain('evil.example')
    expect(loads.join('\n')).not.toContain('evil.example')
  } finally {
    Object.defineProperty(image, 'src', descriptor)
  }
})

test('a participant icon given as an address, however its key is spelled, is not drawn', async () => {
  const source =
    'sequenceDiagram\n  participant A\n  properties A: {"\\u0069con": "https://evil.example/s.png"}\n  A->>A: hi'
  const { result, onPage } = await drawnWhileWatched(source)
  expect(result).toEqual({ error: LOADS_FROM_ELSEWHERE })
  expect(onPage).not.toContain('evil.example')
})

test('while a diagram is drawn, an image it adds may not point off the page', async () => {
  const scratch = document.createElement('div')
  scratch.id = 'dguard-test'
  document.body.append(scratch)
  try {
    await expect(
      withoutRemoteImages('dguard-test', async () => {
        new Image().src = 'https://evil.example/m.png'
      }),
    ).rejects.toThrow(LOADS_FROM_ELSEWHERE)
    await expect(
      withoutRemoteImages('dguard-test', async () => {
        const svgImage = document.createElementNS('http://www.w3.org/2000/svg', 'image')
        scratch.append(svgImage)
        svgImage.setAttribute('href', 'https://evil.example/n.png')
      }),
    ).rejects.toThrow(LOADS_FROM_ELSEWHERE)
    await expect(
      withoutRemoteImages('dguard-test', async () => {
        const svgImage = document.createElementNS('http://www.w3.org/2000/svg', 'image')
        scratch.append(svgImage)
        svgImage.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '//evil.example/o.png')
      }),
    ).rejects.toThrow(LOADS_FROM_ELSEWHERE)

    // The page's own images, an inline one, and a marker of the diagram's own
    // are left alone, and nothing is still guarded once the drawing is done.
    await withoutRemoteImages('dguard-test', async () => {
      const shown = document.createElement('img')
      document.body.append(shown)
      shown.setAttribute('src', 'https://example.com/avatar.png')
      shown.src = 'https://example.com/avatar-2.png'
      new Image().src = 'data:image/png;base64,AAAA'
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
      scratch.append(use)
      use.setAttribute('href', '#marker')
      shown.remove()
    })
    const later = new Image()
    later.src = 'https://example.com/after.png'
    expect(later.getAttribute('src')).toBe('https://example.com/after.png')
  } finally {
    scratch.remove()
  }
})

test('two copies of one drawing share no id, and each copy’s markers and styles point at its own', async () => {
  for (const source of ['graph TD\n  Start --> Finish', 'sequenceDiagram\n  A->>B: hi\n  B-->>A: done']) {
    const { result } = await drawnWhileWatched(source)
    const { svg } = result as { svg: string }
    const parse = (markup: string) => {
      const holder = document.createElement('div')
      holder.innerHTML = markup
      return holder
    }
    const copies = ['diagram-copy-1', 'diagram-copy-2'].map((scope) => parse(scopeDiagramIds(svg, scope)))
    const idsOf = (copy: Element) => [...copy.querySelectorAll('[id]')].map((element) => element.id)
    const [first, second] = copies.map(idsOf)
    expect(first.length, source).toBeGreaterThan(0)
    expect(
      first.filter((id) => second.includes(id)),
      source,
    ).toEqual([])
    for (const copy of copies) {
      const own = new Set(idsOf(copy))
      const markup = copy.innerHTML
      const referenced = [...markup.matchAll(/url\((?:&quot;|["'])?#([^)"'&]+)/gu)].map((match) => match[1])
      expect(referenced.length, source).toBeGreaterThan(0)
      for (const id of referenced) expect(own.has(id), `${source}: url(#${id})`).toBe(true)
      const svgId = copy.querySelector('svg')!.id
      expect(copy.querySelector('style')?.textContent ?? '', source).toContain(`#${svgId}`)
    }
  }
})

test('ordinary diagrams of several kinds still draw', async () => {
  for (const source of [
    'flowchart LR\n  A@{ shape: rounded, label: "Start" } --> B',
    'sequenceDiagram\n  participant A\n  properties A: {"icon": "@clock"}\n  A->>B: hi',
    'classDiagram\n  class Animal',
    'stateDiagram-v2\n  [*] --> Still',
    'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
  ]) {
    const { result } = await drawnWhileWatched(source)
    expect(result, source).toMatchObject({ svg: expect.stringContaining('<svg') })
  }
})

test('the guard alone stops the image Mermaid loads to measure a node', async () => {
  // Past both readings of the source, straight to the renderer.
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false })
  const { onPage } = await (async () => {
    const drawn = withoutRemoteImages('dguard-render', () =>
      mermaid.render('guard-render', 'flowchart TD\n  A@{ img: "https://evil.example/r.png" }'),
    )
    await expect(drawn).rejects.toThrow(LOADS_FROM_ELSEWHERE)
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { onPage: [...mounted].map((element) => element.outerHTML).join('\n') }
  })()
  document.getElementById('dguard-render')?.remove()
  expect(onPage).not.toContain('evil.example')
})
