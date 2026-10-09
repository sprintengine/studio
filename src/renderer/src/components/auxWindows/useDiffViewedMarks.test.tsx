import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { afterEach, test } from 'vitest'

import type { DiffFileItem } from './diffFileList'

// The viewer's marks kept in step with the working tree: a marked file whose
// diff moved while another file was open loses its mark on the next tick.

const file = (relativePath: string): DiffFileItem => ({
  path: `/Users/dev/acme/${relativePath}`,
  relativePath,
  status: 'modified',
  kind: 'unstaged',
})

let cleanup: (() => Promise<void>) | null = null

/** Let the delayed pass run and finish. */
async function settle(view: { act: (work: () => Promise<void>) => Promise<void> }) {
  for (let round = 0; round < 3; round++) await view.act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
}
afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

async function mount(
  contents: Map<string, string>,
  options: { probes?: Map<string, string>; active?: () => boolean; loads?: string[] } = {},
) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useDiffViewedMarks } = await import('./useDiffViewedMarks')
  const items = [file('a.ts'), file('b.ts')]
  let state!: ReturnType<typeof useDiffViewedMarks>
  function Harness({ revision }: { revision: number }) {
    state = useDiffViewedMarks({
      repoRoot: '/Users/dev/acme',
      items,
      revision,
      ready: true,
      complete: true,
      active: options.active?.() ?? true,
      currentKey: null,
      delayMs: 0,
      load: async (item) => {
        options.loads?.push(item.relativePath)
        return { state: 'ready', original: '', modified: contents.get(item.relativePath) ?? '' }
      },
      probe: async (item) => options.probes?.get(item.relativePath) ?? null,
    })
    return null
  }
  const root = createRoot(dom.window.document.createElement('div'))
  const render = (revision: number) => act(async () => root.render(createElement(Harness, { revision })))
  cleanup = async () => {
    await act(async () => root.unmount())
    dom.window.close()
    for (const name of Object.keys(globals)) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name])
      else Reflect.deleteProperty(globalThis, name)
    }
  }
  return { act, items, state: () => state, render }
}

test('a marked file that changes behind the viewer is unmarked on the next tick, and an unchanged one keeps its mark', async () => {
  const { fingerprintDiffContent } = await import('./diffViewedMarks')
  const contents = new Map([
    ['a.ts', 'first'],
    ['b.ts', 'other'],
  ])
  const view = await mount(contents)
  await view.render(1)
  const read = (text: string) => fingerprintDiffContent({ state: 'ready', original: '', modified: text })
  await view.act(async () => {
    view.state().setViewed(view.items[0]!, read('first'), true)
    view.state().setViewed(view.items[1]!, read('other'), true)
  })
  assert.equal(Object.keys(view.state().marks).length, 2)
  contents.set('a.ts', 'second')
  await view.render(2)
  await settle(view)
  assert.deepEqual(Object.keys(view.state().marks), ['unstaged:b.ts'])
})

test('the open file read again as changed loses its mark at once', async () => {
  const { fingerprintDiffContent } = await import('./diffViewedMarks')
  const view = await mount(new Map([['a.ts', 'first']]))
  await view.render(1)
  const read = (text: string) => fingerprintDiffContent({ state: 'ready', original: '', modified: text })
  await view.act(async () => view.state().setViewed(view.items[0]!, read('first'), true))
  await view.act(async () => view.state().noteContent(view.items[0]!, read('first')))
  assert.equal(Object.keys(view.state().marks).length, 1, 'the same diff keeps it')
  await view.act(async () => view.state().noteContent(view.items[0]!, read('changed')))
  assert.deepEqual(view.state().marks, {})
})

test('a marked file is read again only when its probe moved, and nothing is read while the viewer is out of sight', async () => {
  const { fingerprintDiffContent } = await import('./diffViewedMarks')
  const probes = new Map([
    ['a.ts', '10@1'],
    ['b.ts', '20@1'],
  ])
  const loads: string[] = []
  let active = true
  const view = await mount(
    new Map([
      ['a.ts', 'first'],
      ['b.ts', 'other'],
    ]),
    { probes, loads, active: () => active },
  )
  await view.render(1)
  const read = (text: string) => fingerprintDiffContent({ state: 'ready', original: '', modified: text })
  await view.act(async () => {
    view.state().setViewed(view.items[0]!, read('first'), true)
    view.state().setViewed(view.items[1]!, read('other'), true)
  })
  await view.render(2)
  await settle(view)
  assert.deepEqual(loads.sort(), ['a.ts', 'b.ts'], 'each is read once to learn its probe')
  loads.length = 0
  await view.render(3)
  await settle(view)
  assert.deepEqual(loads, [], 'a tick that moved neither file reads nothing')
  probes.set('a.ts', '11@2')
  await view.render(4)
  await settle(view)
  assert.deepEqual(loads, ['a.ts'], 'only the file that moved is read')
  loads.length = 0
  active = false
  probes.set('b.ts', '21@2')
  await view.render(5)
  await settle(view)
  assert.deepEqual(loads, [], 'out of sight, nothing is checked')
})
