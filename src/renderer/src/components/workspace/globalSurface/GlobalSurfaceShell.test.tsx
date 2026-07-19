import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { GlobalSurfaceShell } from './GlobalSurfaceShell'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// The mockup §1/§2 anatomy: a labelled surface region → surface bar (title ·
// status chip · context sub · actions) → optional attention strip → body of an
// optional internal rail beside the canvas. Each slot is proven present when
// supplied and absent when omitted.
run('renders the full anatomy when every slot is supplied', () => {
  const html = renderToStaticMarkup(
    <GlobalSurfaceShell
      ariaLabel="Roadmap"
      bar={{
        title: 'summer26',
        statusChip: <span data-testid="chip">Active</span>,
        contextSub: '2 tracks · 7 steps',
        actions: <button type="button">Edit plan</button>,
      }}
      attention={<div data-testid="wait">Approve &amp; merge</div>}
      rail={<button type="button" data-testid="rail-row">summer26</button>}
    >
      <div data-testid="canvas">board</div>
    </GlobalSurfaceShell>,
  )
  // The surface is a labelled region landmark, not a dialog (no role="dialog",
  // no aria-modal) — it is a page, so nothing here traps focus or scrims.
  assert.match(html, /<section aria-label="Roadmap"/, 'the surface is a labelled region landmark')
  assert.doesNotMatch(html, /role="dialog"|aria-modal/, 'the surface is a page, never a dialog')
  // Surface bar: heading + every optional bit.
  assert.match(html, /<h2[^>]*>summer26<\/h2>/, 'the bar renders the title as the region heading')
  assert.match(html, /data-testid="chip"/, 'the status chip slot renders')
  assert.match(html, /2 tracks · 7 steps/, 'the context sub renders')
  assert.match(html, /Edit plan/, 'the actions slot renders')
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
  assert.match(html, /<section aria-label="Roadmap"/, 'the region landmark is always present')
  assert.doesNotMatch(html, /<h2/, 'no surface bar is rendered without bar content — the canvas self-chromes')
  assert.doesNotMatch(html, /<aside/, 'no rail is rendered when omitted')
  assert.match(html, /data-testid="board"/, 'the canvas hosts the surface content full-width')
})

console.log('GlobalSurfaceShell anatomy tests passed')
