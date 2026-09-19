import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { GlobalSurfaceShell, ModalSurfaceChromeContext, ModalSurfaceFrame } from './GlobalSurfaceShell'
import { test } from 'vitest'

test('GlobalSurfaceShell', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  // The mockup §1/§2 anatomy: a labelled surface region → surface bar (the door's
  // NAME and its actions, nothing else) → optional attention strip → body of an
  // optional internal rail beside the canvas. Each slot is proven present when
  // supplied and absent when omitted. The bar carries no status chip and no counts
  // line: state belongs to the thing that has it, not to the title of the room.
  run('renders the full anatomy when every slot is supplied', () => {
    const html = renderToStaticMarkup(
      <GlobalSurfaceShell
        ariaLabel="Roadmap"
        bar={{
          title: 'summer26',
          actions: <button type="button">Edit plan</button>,
        }}
        attention={<div data-testid="wait">Approve &amp; merge</div>}
        rail={
          <button type="button" data-testid="rail-row">
            summer26
          </button>
        }
      >
        <div data-testid="canvas">board</div>
      </GlobalSurfaceShell>,
    )
    // The surface is a labelled region landmark, not a dialog (no role="dialog",
    // no aria-modal) — it is a page, so nothing here traps focus or scrims. It is
    // programmatically focusable (`tabindex="-1"`, never in the tab order) so a
    // surface that mounts from a control that unmounted with it — an Extensions
    // home tile — can take the focus that click dropped on the floor.
    assert.match(html, /<section tabindex="-1" aria-label="Roadmap"/, 'the surface is a labelled region landmark')
    assert.doesNotMatch(html, /role="dialog"|aria-modal/, 'the surface is a page, never a dialog')
    // Surface bar: heading + every optional bit.
    assert.match(html, /<h2[^>]*>summer26<\/h2>/, 'the bar renders the title as the region heading')
    assert.match(html, /Edit plan/, 'the actions slot renders')
    assert.doesNotMatch(html, /Active|2 tracks/, 'the bar carries no status chip and no counts line')
    // Attention strip, rail (a labelled list aside), and canvas.
    assert.match(html, /data-testid="wait"/, 'the attention strip renders')
    assert.match(html, /<aside aria-label="Roadmap list"/, 'the rail is a labelled list aside owned by the surface')
    assert.match(html, /data-testid="rail-row"/, 'the rail content renders')
    assert.match(html, /data-testid="canvas"/, 'the canvas renders the children')
  })

  run('renders canvas-only when the bar and rail are omitted (the Roadmap T1 tenant)', () => {
    const html = renderToStaticMarkup(
      <GlobalSurfaceShell ariaLabel="Roadmap">
        <div data-testid="board">self-chromed board</div>
      </GlobalSurfaceShell>,
    )
    assert.match(html, /<section tabindex="-1" aria-label="Roadmap"/, 'the region landmark is always present')
    assert.doesNotMatch(html, /<h2/, 'no surface bar is rendered without bar content — the canvas self-chromes')
    assert.doesNotMatch(html, /<aside/, 'no rail is rendered when omitted')
    assert.match(html, /data-testid="board"/, 'the canvas hosts the surface content full-width')
  })

  // Doors→modals (2026-09-01), owner ruling: every modal closes the same one
  // way — an X at the top right of its bar. In a modal host (the chrome context
  // is provided) the door-era back chevron never renders, even when the surface
  // passes onBack; outside one (a door, tests) the chevron stays the one exit
  // and no X appears.
  run('a modal host swaps the back chevron for a closing X; a door host keeps the chevron', () => {
    const surface = (
      <GlobalSurfaceShell
        ariaLabel="Automations"
        // The surface's own bar title is contextual — mid-visit it becomes the
        // selected automation's name. The modal bar must ignore it.
        bar={{ title: 'nightly-review' }}
        onBack={() => {}}
        canGoBack
      >
        <div>canvas</div>
      </GlobalSurfaceShell>
    )
    const inModal = renderToStaticMarkup(
      <ModalSurfaceChromeContext.Provider value={{ close: () => {}, label: 'Automations', onBarPresence: () => {} }}>
        {surface}
      </ModalSurfaceChromeContext.Provider>,
    )
    assert.match(inModal, /aria-label="Close"/, 'the modal bar renders the closing X')
    assert.doesNotMatch(inModal, /aria-label="Back"/, 'and no back chevron beside it')
    assert.match(
      inModal,
      /<h2[^>]*>Automations<\/h2>/,
      'the modal bar is titled by the host label — the surface’s name',
    )
    assert.doesNotMatch(inModal, /<h2[^>]*>nightly-review<\/h2>/, 'never by the surface’s own contextual bar title')

    const inDoor = renderToStaticMarkup(surface)
    assert.match(inDoor, /aria-label="Back"/, 'a door bar keeps its chevron')
    assert.doesNotMatch(inDoor, /aria-label="Close"/, 'and grows no X')
    assert.match(inDoor, /<h2[^>]*>nightly-review<\/h2>/, 'a door bar keeps the surface’s own title')
  })

  // The host frame's fallback bar: a body that never renders the shell (a
  // third-party modal surface, or a lazy body still in Suspense) still gets the
  // titled bar with the X — the one-close-mechanism ruling holds by
  // construction, not convention.
  run('the modal frame renders the fallback title bar for a body that brings no bar', () => {
    const html = renderToStaticMarkup(
      <ModalSurfaceFrame label="Atlas" close={() => {}}>
        <div>bare third-party body</div>
      </ModalSurfaceFrame>,
    )
    assert.match(html, /<h2[^>]*>Atlas<\/h2>/, 'the frame titles the modal with the host label')
    assert.match(html, /aria-label="Close"/, 'and renders the closing X')
  })

  console.log('GlobalSurfaceShell anatomy tests passed')
})
