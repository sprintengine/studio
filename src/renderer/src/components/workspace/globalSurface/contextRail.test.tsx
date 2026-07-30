import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// Item 1993 — drill-in REPLACES the rail. Three claims this suite holds to,
// because each of them is silent when it breaks:
//
//   1. A surface's rail lifts OUT of the shell into the host's column, and the
//      shell then renders neither its inline aside nor a bar back chevron. Miss
//      either half and the app is back to two navigation columns, or to two back
//      affordances answering one question.
//   2. The app sidebar hides its own rail while a surface owns the column, and
//      the row that opened the surface stays in the DOM so Back can hand focus
//      to it. Unmounting it instead reads identical on screen and quietly loses
//      the keyboard.
//   3. Escape leaves the SURFACE, not whatever is open on top of it. A dialog, a
//      menu and a listbox each close themselves first; a keystroke from the
//      door's own rail or canvas is the door's.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
anyGlobal.window = domWindow
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.localStorage = dom.window.localStorage
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
})) as unknown as typeof dom.window.matchMedia
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = NoopResizeObserver
dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver
domWindow.api = { platform: 'darwin' }

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { ContextRailColumn, ContextRailSlotContext, escapeLeavesSurface } = await import('./contextRail')
  const { GlobalSurfaceShell } = await import('./GlobalSurfaceShell')
  const { SIDEBAR_DEFAULT_WIDTH } = await import('../sidebarWidth')
  const { default: WorkspaceSidebar } = await import('../WorkspaceSidebar')

  const document = dom.window.document

  function mount(node: React.ReactNode): { container: HTMLElement; unmount: () => void } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(node)
    })
    return {
      container: container as unknown as HTMLElement,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  // ── 1. the shell lifts its rail, and stops drawing a second back affordance ──

  run('with no host column the shell keeps its inline aside, at the ONE rail width', () => {
    const view = mount(
      <GlobalSurfaceShell
        ariaLabel="Horizon"
        bar={{ title: 'summer26' }}
        rail={<button type="button" data-testid="rail-row">summer26</button>}
        onBack={() => undefined}
        canGoBack
      >
        <div>canvas</div>
      </GlobalSurfaceShell>,
    )
    const aside = view.container.querySelector('aside')
    assert.ok(aside, 'the fallback host still gets a rail')
    assert.equal(
      (aside as HTMLElement).style.width,
      `${SIDEBAR_DEFAULT_WIDTH}px`,
      'and it is the app sidebar width, not a second rail width of its own',
    )
    assert.ok(aside!.querySelector('[data-testid="rail-row"]'), 'the rail content is inside it')
    assert.ok(
      view.container.querySelector('button[aria-label="Back"]'),
      'this host has no rail row to carry back, so the bar chevron stays',
    )
    view.unmount()
  })

  run('given a host column the rail moves into it and the bar chevron goes', () => {
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    const view = mount(
      <ContextRailSlotContext.Provider value={{ el: slot as unknown as HTMLElement }}>
        <GlobalSurfaceShell
          ariaLabel="Horizon"
          bar={{ title: 'summer26' }}
          rail={<button type="button" data-testid="rail-row">summer26</button>}
          onBack={() => undefined}
          canGoBack
        >
          <div>canvas</div>
        </GlobalSurfaceShell>
      </ContextRailSlotContext.Provider>,
    )
    assert.equal(view.container.querySelector('aside'), null, 'no second navigation column beside the host’s')
    assert.ok(slot.querySelector('[data-testid="rail-row"]'), 'the rail rendered into the host’s column')
    assert.equal(
      view.container.querySelector('button[aria-label="Back"]'),
      null,
      'and the bar/canvas carries no back affordance — the rail’s pinned row is the one way out',
    )
    view.unmount()
    slot.remove()
  })

  run('a surface with no rail replaces nothing, and keeps its one way back', () => {
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    const presence: boolean[] = []
    const view = mount(
      <ContextRailSlotContext.Provider
        value={{ el: slot as unknown as HTMLElement, onRailPresence: (present) => presence.push(present) }}
      >
        <GlobalSurfaceShell ariaLabel="Backlog" bar={{ title: 'Backlog' }} onBack={() => undefined} canGoBack>
          <div>list beside its own preview</div>
        </GlobalSurfaceShell>
      </ContextRailSlotContext.Provider>,
    )
    assert.deepEqual(presence, [false], 'the host is told there is no rail to take')
    assert.ok(
      view.container.querySelector('button[aria-label="Back"]'),
      'so the bar chevron stays — otherwise this door would have no way out at all',
    )
    view.unmount()
    slot.remove()
  })

  // ── 2. the rail column, and the sidebar it replaces ─────────────────────────

  run('the host column pins Back below the rail scrollport', () => {
    let backs = 0
    const view = mount(
      <ContextRailColumn
        surfaceKey="roadmap"
        ariaLabel="Horizon rail"
        active
        railRef={() => undefined}
        onBack={() => {
          backs += 1
        }}
      />,
    )
    const column = view.container.querySelector('[data-context-rail]')
    assert.ok(column, 'the column is findable by the marker Escape resolution uses')
    const children = [...column!.children] as HTMLElement[]
    assert.equal(children.length, 2, 'a scrollport and one pinned row, nothing else')
    assert.equal(children[0].getAttribute('aria-label'), 'Horizon rail', 'the scrollport is the named rail')
    assert.equal(children[1].tagName, 'BUTTON', 'Back is the last thing in the column')
    assert.match(children[1].textContent ?? '', /Back/)
    act(() => {
      children[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(backs, 1, 'and it invokes the host’s back — closeGlobalSurface, never NavHistory')
    view.unmount()
  })

  run('the sidebar hides its own rail for a surface, keeping the trigger reachable', () => {
    type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
    const noop = (): void => {}
    const baseProps = {
      workspaces: [{ id: 'w1', name: 'Alpha', mode: 'standard', folderPath: '/projA' }],
      activeWorkspaceId: 'w1',
      workspaceWindowId: 'win1',
      isDetachedWindow: false,
      sidebarCollapsed: false,
      chromeSlot: <div data-testid="chrome">chrome</div>,
      activityByWorkspaceId: {},
      residentWorkspaceIds: new Set<string>(),
      terminalRecencyByWorkspaceId: {},
      onSelectWorkspace: noop,
      onMoveWorkspaceToNewWindow: noop,
      onMoveWorkspaceToMainWindow: noop,
      onCloseWorkspace: noop,
      onDeleteWorkspaceWithState: noop,
      onForgetFolder: noop,
      onNewWorkspace: noop,
      onNewWorkspaceInFolder: noop,
      onNewChat: noop,
      onNewWorkspaceMode: noop,
      onNewChatInFolder: noop,
      onRevealFolder: noop,
      onSetSidebarCollapsed: noop,
      sidebarWidth: 260,
      onSetSidebarWidth: noop,
      authState: { authenticated: false },
      authMessage: null,
      accountOpen: false,
      setAccountOpen: noop,
      startLogin: noop,
      refreshAuthState: noop,
      logout: noop,
      openSettings: noop,
      settingsOpen: false,
    } as unknown as SidebarProps

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<WorkspaceSidebar {...baseProps} />)
    })
    const tree = container.querySelector('nav[role="tree"]') as HTMLElement | null
    assert.ok(tree, 'the workspaces rail is there to begin with')
    assert.equal(tree!.className.includes('hidden'), false, 'and visible')

    act(() => {
      root.render(
        <WorkspaceSidebar
          {...baseProps}
          contextRail={<div data-testid="surface-rail">surface rail</div>}
          contextRailActive
        />,
      )
    })
    assert.ok(container.querySelector('[data-testid="surface-rail"]'), 'the surface’s rail took the column')
    assert.ok(container.querySelector('[data-testid="chrome"]'), 'the chrome strip above does NOT swap')
    const hiddenTree = container.querySelector('nav[role="tree"]') as HTMLElement | null
    assert.ok(hiddenTree, 'the workspaces rail stays MOUNTED — the door’s trigger has to survive')
    assert.ok(hiddenTree!.className.includes('hidden'), 'and hidden, so it is neither seen nor tabbable')

    act(() => {
      root.render(<WorkspaceSidebar {...baseProps} />)
    })
    const restored = container.querySelector('nav[role="tree"]') as HTMLElement | null
    assert.equal(restored!.className.includes('hidden'), false, 'Back restores the rail it replaced')
    act(() => root.unmount())
    container.remove()
  })

  // ── 3. whose Escape is it ───────────────────────────────────────────────────

  run('Escape belongs to the surface only when nothing is open on top of it', () => {
    const region = document.createElement('div')
    region.innerHTML = `
      <button id="canvas-control" type="button">Approve</button>
      <div role="dialog"><button id="in-dialog" type="button">Confirm</button></div>
      <div role="menu"><button id="in-menu" type="button">Remove step</button></div>
      <div role="listbox"><div id="in-listbox" tabindex="-1">Opus</div></div>
    `
    const railColumn = document.createElement('div')
    railColumn.setAttribute('data-context-rail', '')
    railColumn.innerHTML = '<button id="rail-row" type="button">summer26</button>'
    const outside = document.createElement('button')
    document.body.append(region, railColumn, outside)
    const at = (id: string): HTMLElement => region.querySelector(`#${id}`) as HTMLElement
    const asRegion = region as unknown as HTMLElement

    assert.equal(escapeLeavesSurface(at('canvas-control'), asRegion), true, 'from the canvas: leave the door')
    assert.equal(
      escapeLeavesSurface(railColumn.querySelector('#rail-row') as HTMLElement, asRegion),
      true,
      'from the rail column: leave the door, even though the rail is not inside the canvas region',
    )
    assert.equal(escapeLeavesSurface(at('in-dialog'), asRegion), false, 'a dialog closes itself first')
    assert.equal(escapeLeavesSurface(at('in-menu'), asRegion), false, 'so does a menu')
    assert.equal(escapeLeavesSurface(at('in-listbox'), asRegion), false, 'so does a listbox')
    assert.equal(
      escapeLeavesSurface(outside as unknown as HTMLElement, asRegion),
      false,
      'and a keystroke from outside the surface is not the surface’s to act on',
    )
    assert.equal(escapeLeavesSurface(null, asRegion), false, 'nothing focused, nothing to leave')
    assert.equal(
      escapeLeavesSurface(at('canvas-control'), null),
      false,
      'no surface region mounted yet: the canvas cannot claim the key',
    )
    region.remove()
    railColumn.remove()
    outside.remove()
  })

  console.log('context rail: all checks passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
