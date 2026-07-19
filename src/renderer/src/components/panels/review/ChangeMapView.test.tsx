import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChangeMapView } from './ChangeMapView'
import { mockupChangeMap, mockupChangeMapStepIds } from './fixtures'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const html = renderToStaticMarkup(
  <ChangeMapView changeMap={mockupChangeMap} orderedStepIds={mockupChangeMapStepIds} onNavigate={() => {}} />,
)

run('renders every entity node from the mockup map', () => {
  for (const label of ['Invitation model', 'Migration', 'Invitations API', 'Invite email', 'Members UI', 'API tests']) {
    assert.ok(html.includes(label), `missing node label: ${label}`)
  }
  // Mono sublabels ride along.
  assert.ok(html.includes('prisma/schema.prisma'))
  assert.ok(html.includes('settings/members page'))
})

run('renders every labeled relationship', () => {
  for (const label of ['creates', 'queried by', 'sends', 'feeds', 'covers']) {
    assert.ok(html.includes(`>${label}<`), `missing edge label: ${label}`)
  }
})

run('renders the deploy-order caption from deployNote', () => {
  assert.ok(html.includes('Deploy order:'))
  assert.ok(html.includes('migration before UI — the members page needs the role column.'))
})

run('every node is a keyboard-reachable button that names its step', () => {
  assert.ok(html.includes('role="button"'))
  assert.ok(html.includes('tabindex="0"'))
  // Each node's accessible name points at its step number.
  for (const step of [1, 2, 3, 4]) {
    assert.ok(html.includes(`Go to step ${step}`), `no node targets step ${step}`)
  }
})

run('summarizes the whole diagram in prose for screen readers', () => {
  assert.match(html, /aria-label="Change map of 6 entities[^"]*"/)
})

run('is token-only — no hardcoded color literals', () => {
  assert.ok(html.includes('var(--bg-hover)'))
  assert.ok(html.includes('var(--accent-primary)'))
  assert.ok(html.includes('var(--border-strong)'))
  // No hex color anywhere (the marker url reference is not a color).
  assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b/)
})

run('an empty map renders nothing (no gap, no placeholder)', () => {
  const empty = renderToStaticMarkup(
    <ChangeMapView changeMap={{ nodes: [], edges: [] }} orderedStepIds={mockupChangeMapStepIds} onNavigate={() => {}} />,
  )
  assert.equal(empty, '')
})

console.log('all ChangeMapView render tests passed')
