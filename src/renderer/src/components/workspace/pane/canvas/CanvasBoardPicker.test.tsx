import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

import type { CanvasBoardSummary, CanvasResult } from '../../../../../../shared/canvas/types'
import { test } from 'vitest'

test('CanvasBoardPicker', async () => {
  // The board picker: its four states, the list card it draws them in, the page
  // it stands on, and the one value it produces.
  //
  // It is the surface a Canvas tab shows before it has a board, so it is the
  // first thing a person sees of the feature. The three states that are not "here
  // are your boards" (still reading, could not read, nothing there yet) are
  // exactly the ones that go unexercised by hand, and so is the second page.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window as unknown as Record<string, unknown>
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
  anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  let failures = 0
  function run(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  // The same reporter for a case that has to drive React and wait for it. A
  // separate name rather than one that takes both, so a forgotten `await` is a
  // type error rather than a case that silently always passes.
  async function runAsync(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  const MINUTE = 60_000
  const HOUR = 60 * MINUTE

  // Timestamps are built BEFORE the picker mounts, so the clock it reads is never
  // earlier than a board's mtime: a fixture written "5 minutes ago" is five
  // minutes and a fraction old by the time it is drawn, and rounds down to `5m`
  // rather than to `4m` on a slow machine.
  function board(path: string, name: string, agoMs = 3 * HOUR): CanvasBoardSummary {
    return { path, name, elementCount: 3, modifiedAt: Date.now() - agoMs }
  }

  /** `count` boards, newest first, exactly as the service returns them. */
  function boardRun(count: number): CanvasBoardSummary[] {
    return Array.from({ length: count }, (_, index) =>
      board(`diagrams/b${index + 1}.excalidraw`, `b${index + 1}`, (index + 1) * MINUTE),
    )
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { CanvasBoardPicker } = await import('./CanvasBoardPicker')

    const document = dom.window.document
    let listBoards: () => Promise<CanvasResult<CanvasBoardSummary[]>> = async () => ({ ok: true, value: [] })
    ;(dom.window as unknown as { api: unknown }).api = {
      platform: 'darwin',
      canvasListBoards: () => listBoards(),
    }

    function click(element: Element): Promise<void> {
      return act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }

    function press(element: Element, key: string): Promise<void> {
      return act(async () => {
        element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }))
      })
    }

    function type(input: HTMLInputElement, value: string): Promise<void> {
      return act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    }

    async function mount(props: { onPick?: (path: string) => void; openPaths?: readonly string[] } = {}) {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(
          <CanvasBoardPicker workspaceId="ws-1" onPick={props.onPick ?? (() => {})} openPaths={props.openPaths} />,
        )
      })
      const buttons = () => [...container.querySelectorAll('button')]
      return {
        container,
        text: () => container.textContent ?? '',
        buttons,
        named: (label: string) => buttons().find((element) => element.textContent?.trim() === label),
        rows: () => [...container.querySelectorAll('ul > li')],
        newBoard: () => buttons().find((element) => element.textContent?.includes('New board'))!,
        field: () => container.querySelector('input') as HTMLInputElement | null,
        unmount: async () => {
          await act(async () => root.unmount())
          container.remove()
        },
      }
    }

    // --- The three states that are not a list ---------------------------------

    {
      // A list that never answers: the card is already there, holding rows that
      // are the shape of the rows about to arrive.
      listBoards = () => new Promise(() => {})
      const view = await mount()
      run('while the boards are being read, the card holds placeholder rows', () => {
        assert.equal(view.rows().length, 3)
        assert.ok(
          view.container.querySelector('.skeleton-shimmer'),
          'the placeholder rows shimmer rather than reading as real boards',
        )
        assert.equal(
          view.newBoard().hasAttribute('disabled'),
          true,
          'a new board cannot be named until we know which names the project has',
        )
      })
      await view.unmount()
    }

    {
      listBoards = async () => ({
        ok: false,
        error: { code: 'no_workspace', message: 'This workspace has no folder.' },
      })
      const view = await mount()
      run('a failed read is named, with the reason and a way to try again', () => {
        assert.match(view.text(), /The boards could not be listed/)
        assert.match(view.text(), /This workspace has no folder\./)
        assert.ok(view.named('Try again'), 'the failure offers a retry rather than needing the tab reopened')
        assert.equal(
          view.buttons().some((element) => element.textContent?.includes('New board')),
          false,
          'nothing offers to create a board into a project that could not be listed',
        )
      })
      await view.unmount()
    }

    {
      listBoards = async () => ({ ok: true, value: [] })
      const view = await mount()
      run('a project with no boards is told what a board is and where it goes', () => {
        assert.match(view.text(), /No boards yet/)
        assert.match(view.text(), /diagrams folder/)
        assert.match(view.text(), /you and your agents can both draw on them/)
        assert.ok(view.newBoard(), 'and is still offered one')
        assert.equal(view.container.querySelector('ul'), null, 'with no empty card standing in for a list')
      })
      await view.unmount()
    }

    // --- The list -------------------------------------------------------------

    {
      const twentyThree = boardRun(23)
      listBoards = async () => ({ ok: true, value: twentyThree })
      const view = await mount()
      run('ten boards to a page, in the order the service handed them over', () => {
        assert.equal(view.rows().length, 10)
        assert.deepEqual(
          view.rows().map((row) => row.querySelector('button')?.getAttribute('aria-label')?.split(',')[0]),
          Array.from({ length: 10 }, (_, index) => `Open board b${index + 1}`),
        )
      })
      run('the list is a labelled list card, one row per board', () => {
        const card = view.container.querySelector('ul')!
        assert.equal(card.getAttribute('aria-label'), 'Boards')
        assert.equal(card.querySelectorAll(':scope > li').length, 10)
      })
      run('the heading counts every board, not the page', () => {
        assert.match(view.text(), /Boards\s*23/)
      })
      run('the pager says where in the list this page is', () => {
        const pager = view.container.querySelector('nav')!
        assert.equal(pager.getAttribute('aria-label'), 'Boards in this project')
        assert.match(pager.textContent ?? '', /Showing 1–10 of 23/)
      })
      await runAsync('the second page continues the list, and the heading does not move', async () => {
        const second = view.buttons().find((element) => element.getAttribute('aria-label') === 'Page 2')!
        await click(second)
        assert.equal(
          view.rows()[0].querySelector('button')?.getAttribute('aria-label')?.split(',')[0],
          'Open board b11',
        )
        assert.equal(view.rows().length, 10)
        assert.match(view.container.querySelector('nav')!.textContent ?? '', /Showing 11–20 of 23/)
      })
      await runAsync('the last page holds what is left', async () => {
        const third = view.buttons().find((element) => element.getAttribute('aria-label') === 'Page 3')!
        await click(third)
        assert.equal(view.rows().length, 3)
        assert.match(view.container.querySelector('nav')!.textContent ?? '', /Showing 21–23 of 23/)
      })
      await view.unmount()
    }

    {
      const ten = boardRun(10)
      listBoards = async () => ({ ok: true, value: ten })
      const view = await mount()
      run('a single page draws no pager: the heading already counts it', () => {
        assert.equal(view.rows().length, 10)
        assert.equal(view.container.querySelector('nav'), null)
      })
      await view.unmount()
    }

    {
      const mixed = [
        board('diagrams/checkout-flow.excalidraw', 'checkout-flow', 30_000),
        board('diagrams/architecture.excalidraw', 'architecture', 5 * MINUTE),
        board('docs/legacy/architecture.excalidraw', 'architecture', 3 * HOUR),
        board('diagrams/queue-topology.excalidraw', 'queue-topology', 30 * HOUR),
      ]
      listBoards = async () => ({ ok: true, value: mixed })
      const picked: string[] = []
      const view = await mount({ onPick: (path) => picked.push(path) })
      run('a row states its name and when it changed, in the shortest form that says it', () => {
        const rows = view.rows().map((row) => row.textContent ?? '')
        assert.match(rows[0], /checkout-flow/)
        assert.match(rows[0], /now/)
        assert.match(rows[1], /5m/)
        assert.match(rows[2], /3h/)
        assert.match(rows[3], /yesterday/)
      })
      run('only the two boards sharing a name say which folder they are in', () => {
        const rows = view.rows().map((row) => row.textContent ?? '')
        assert.match(rows[1], /diagrams/)
        assert.match(rows[2], /docs\/legacy/)
        assert.doesNotMatch(rows[0], /diagrams/, 'a unique name needs no folder beside it')
        assert.doesNotMatch(rows[3], /diagrams/)
      })
      run('the full fact is in the row’s name, folder and time spelled out', () => {
        const label = view.rows()[2].querySelector('button')!.getAttribute('aria-label')
        assert.equal(label, 'Open board architecture, in docs/legacy, changed 3 hours ago')
      })
      await runAsync('picking a row hands the tab that board', async () => {
        await click(view.rows()[0].querySelector('button')!)
        assert.deepEqual(picked, ['diagrams/checkout-flow.excalidraw'])
      })
      await view.unmount()
    }

    {
      // A board another tab already holds says so on its row: picking it moves
      // the person rather than opening anything.
      const pair = [board('diagrams/arch.excalidraw', 'arch'), board('diagrams/flow.excalidraw', 'flow')]
      listBoards = async () => ({ ok: true, value: pair })
      const view = await mount({ openPaths: ['diagrams/Arch.excalidraw'] })
      run('a board another tab holds is marked open, whatever case its path is in', () => {
        const rows = view.rows().map((row) => row.textContent ?? '')
        assert.match(rows[0], /Open/)
        assert.doesNotMatch(rows[1], /Open/)
        assert.match(
          view.rows()[0].querySelector('button')!.getAttribute('aria-label') ?? '',
          /already open in another tab/,
        )
      })
      await view.unmount()
    }

    // --- Making one -----------------------------------------------------------

    {
      const one = [board('diagrams/canvas.excalidraw', 'canvas')]
      listBoards = async () => ({ ok: true, value: one })
      const picked: string[] = []
      const view = await mount({ onPick: (path) => picked.push(path) })

      await runAsync('N opens the field, as the first row of the card', async () => {
        assert.equal(view.field(), null, 'no field until one is asked for')
        await press(view.rows()[0].querySelector('button')!, 'n')
        const field = view.field()
        assert.ok(field, 'the letter the button hints is the letter that works')
        assert.equal(view.rows()[0].contains(field!), true, 'it is the first row, above the boards')
        assert.equal(view.rows().length, 2)
        assert.equal(
          view.buttons().some((element) => element.textContent?.includes('New board')),
          false,
          'the heading’s button is gone while the field it became is open',
        )
      })

      run('the field opens on a name the project is not already using, ready to be typed over', () => {
        const field = view.field()!
        assert.equal(field.value, 'canvas-2')
        assert.equal(dom.window.document.activeElement, field)
        assert.equal(field.selectionStart, 0)
        assert.equal(field.selectionEnd, 'canvas-2'.length)
      })

      await runAsync('Escape puts the row back and the focus where it came from', async () => {
        await press(view.field()!, 'Escape')
        assert.equal(view.field(), null)
        assert.equal(dom.window.document.activeElement, view.newBoard())
      })

      await runAsync('a name that cannot be a board is refused in place, and nothing is created', async () => {
        await click(view.newBoard())
        await type(view.field()!, '../escape')
        await click(view.named('Create')!)
        assert.deepEqual(picked, [], 'the tab is handed nothing')
        const alert = view.container.querySelector('[role="alert"]')
        assert.ok(alert, 'the reason is said where the person is looking')
        assert.match(alert!.textContent ?? '', /climb out of the project/)
        assert.equal(view.field()!.getAttribute('aria-invalid'), 'true')
        assert.equal(view.field()!.getAttribute('aria-describedby'), alert!.id)
        assert.ok(view.field(), 'and the field stays open on the name that needs fixing')
      })

      await runAsync('a name the project already uses is refused rather than opened', async () => {
        await type(view.field()!, 'canvas')
        await click(view.named('Create')!)
        assert.deepEqual(picked, [])
        assert.match(
          view.container.querySelector('[role="alert"]')!.textContent ?? '',
          /already has a board at diagrams\/canvas\.excalidraw/,
        )
      })

      await runAsync('Enter creates the board the field names, once', async () => {
        await type(view.field()!, 'system map')
        const field = view.field()!
        await act(async () => {
          // Twice in one batch: the key held down repeating, or Enter landing in
          // the same frame as a click on Create. One board, not two.
          field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        })
        assert.deepEqual(picked, ['diagrams/system map.excalidraw'])
        assert.equal(view.field(), null, 'and the field closes behind it')
      })

      await view.unmount()
    }

    {
      // Creating from page 3 must not leave the person on page 3: the board they
      // just made is the newest one, which is on page 1.
      const paged = boardRun(23)
      listBoards = async () => ({ ok: true, value: paged })
      const picked: string[] = []
      const view = await mount({ onPick: (path) => picked.push(path) })
      await runAsync('creating a board returns the list to its first page', async () => {
        await click(view.buttons().find((element) => element.getAttribute('aria-label') === 'Page 3')!)
        assert.match(view.container.querySelector('nav')!.textContent ?? '', /Showing 21–23 of 23/)
        await click(view.newBoard())
        await press(view.field()!, 'Enter')
        assert.deepEqual(picked, ['diagrams/canvas.excalidraw'])
        assert.match(view.container.querySelector('nav')!.textContent ?? '', /Showing 1–10 of 23/)
      })
      await view.unmount()
    }

    if (failures > 0) {
      console.error(`${failures} canvas board picker test(s) failed`)
      process.exitCode = 1
      return
    }
    console.log('canvas board picker tests passed')
  }

  const suiteRun = main()

  await suiteRun
})
