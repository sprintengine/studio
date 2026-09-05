import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// RosterEditor (MC-2065) is the shell-free roster surface shared by two hosts:
// Horizon's RosterManagerModal and the New sprint dialog's second screen. The
// contract this suite pins is the one that makes the second host possible at
// all — the editor renders NO dialog role, NO aria-modal and NO scrim of its
// own (the dialog host is already a modal; nesting two aria-modal surfaces
// breaks focus containment), and every piece of roster state flows through the
// useRosterEditor result it is handed. The rail checks drive the real hook
// against the real store, because "create a roster here, see it everywhere"
// is the sentence both hosts show the user.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof dom.window.matchMedia

async function main(): Promise<void> {
  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { RosterEditor } = await import('./RosterEditor')
  const { useRosterEditor } = await import('../workspace/newWorkspace/useRosterEditor')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')

  let failures = 0
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  type Editor = ReturnType<typeof useRosterEditor>
  const editorOptions: Parameters<typeof useRosterEditor>[0] = {
    cliOptions: [],
    cliAvailabilityStatus: 'idle',
    workspaceRoot: null,
  }

  // Mount the editor behind a live useRosterEditor, exactly as a host does.
  // Returns a LIVE accessor: the captured object is replaced every render.
  async function mountEditor(): Promise<{
    container: HTMLElement
    editor: () => Editor
    unmount: () => void
  }> {
    let captured: Editor | null = null
    function Host(): JSX.Element {
      const editor = useRosterEditor(editorOptions)
      captured = editor
      return <RosterEditor editor={editor} />
    }
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Host />)
    })
    assert.ok(captured, 'the editor host rendered')
    return {
      container,
      editor: () => {
        if (!captured) throw new Error('the editor unmounted')
        return captured
      },
      unmount: () => {
        root.unmount()
        container.remove()
      },
    }
  }

  const click = async (element: Element | null | undefined): Promise<void> => {
    assert.ok(element, 'expected the element to exist before clicking it')
    await act(async () => {
      ;(element as HTMLElement).dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    })
  }

  const type = async (element: Element | null | undefined, value: string): Promise<void> => {
    assert.ok(element, 'expected the field to exist before typing into it')
    const field = element as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(field, value)
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }

  await check('shell-free: the editor renders no dialog role, no aria-modal, no scrim', async () => {
    const { container, unmount } = await mountEditor()
    assert.equal(container.querySelector('[role="dialog"]'), null, 'no dialog role of its own')
    assert.equal(container.querySelector('[aria-modal]'), null, 'no aria-modal of its own')
    assert.equal(container.querySelector('.overlay-scrim'), null, 'no scrim wrapper of its own')
    assert.equal(
      container.querySelectorAll('.fixed.inset-0').length,
      0,
      'nothing in the editor positions itself as an overlay',
    )
    unmount()
  })

  await check('the rail creates a named roster through the hook, into the shared store', async () => {
    const { container, editor, unmount } = await mountEditor()
    assert.ok(
      !editor().rosters.some((entry) => entry.name === 'Editor pair'),
      'precondition: the roster does not exist yet',
    )

    const createButton = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === 'New roster',
    )
    assert.ok(createButton, 'the rail renders its create action')
    assert.ok(createButton!.disabled, 'create is disabled until a name is typed')

    await type(container.querySelector('input[placeholder="New roster name"]'), 'Editor pair')
    await click(createButton)

    const saved = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
      .savedRosters?.find((entry) => entry.name === 'Editor pair')
    assert.ok(saved, 'the roster reached the shared store — creation is global, not editor-local')
    assert.equal(editor().selectedRosterId, saved!.id, 'the new roster is selected')
    assert.ok(
      Array.from(container.querySelectorAll('button')).some(
        (element) => element.textContent?.includes('Editor pair'),
      ),
      'the rail lists the new roster',
    )
    unmount()
  })

  await check('the rail selects a roster through the hook, and marks it pressed', async () => {
    const { container, editor, unmount } = await mountEditor()
    // Two known rosters, saved through the hook itself.
    await act(async () => { editor().onSaveRoster('Rail A') })
    await act(async () => { editor().onSaveRoster('Rail B') })
    const railA = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent?.includes('Rail A'),
    )
    assert.ok(railA, 'the rail lists Rail A')
    await click(railA)

    const savedA = editor().rosters.find((entry) => entry.name === 'Rail A')
    assert.ok(savedA, 'Rail A exists in the hook state')
    assert.equal(editor().selectedRosterId, savedA!.id, 'clicking the rail row selects it')
    assert.equal(railA!.getAttribute('aria-pressed'), 'true', 'the selected row is pressed for AT')
    unmount()
  })

  if (failures > 0) {
    console.error(`\n${failures} RosterEditor checks failed`)
    process.exit(1)
  }
  console.log('RosterEditor.test.tsx: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
