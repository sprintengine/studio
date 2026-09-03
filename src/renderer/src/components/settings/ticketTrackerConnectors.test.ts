import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { McpCatalogServer } from '../../../../shared/electron-api'
import { isTicketTracker, partitionTicketTrackers } from './ticketTrackerConnectors'

function server(overrides: Partial<McpCatalogServer> & { id: string; name: string }): McpCatalogServer {
  return { transport: 'http', ...overrides } as McpCatalogServer
}

const LINEAR = server({ id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', ticketTracker: true })
const JIRA = server({ id: 'atlassian', name: 'Atlassian', url: 'https://mcp.atlassian.com/v1/mcp', ticketTracker: true })
const GITHUB = server({ id: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', ticketTracker: true })
const STRIPE = server({ id: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com' })

// Membership is catalogue data, so adding a fifth tracker never touches a
// component. Anything unflagged stays out, however tracker-ish it looks.
test('only catalogue entries flagged as ticket trackers are in scope', () => {
  assert.equal(isTicketTracker(LINEAR), true)
  assert.equal(isTicketTracker(STRIPE), false)
  const bands = partitionTicketTrackers([LINEAR, STRIPE], new Set())
  assert.deepEqual(
    [...bands.installed, ...bands.available].map((entry) => entry.id),
    ['linear'],
  )
})

test('installed trackers band above available ones, each sorted by name', () => {
  const bands = partitionTicketTrackers([LINEAR, JIRA, GITHUB], new Set(['github']))
  assert.deepEqual(bands.installed.map((entry) => entry.id), ['github'])
  assert.deepEqual(bands.available.map((entry) => entry.name), ['Atlassian', 'Linear'])
})

// Sorting by name inside each band means installing something moves it between
// bands without reshuffling everything around it.
test('installing one moves only that entry between bands', () => {
  const before = partitionTicketTrackers([LINEAR, JIRA, GITHUB], new Set())
  const after = partitionTicketTrackers([LINEAR, JIRA, GITHUB], new Set(['linear']))
  assert.deepEqual(before.available.map((e) => e.id), ['atlassian', 'github', 'linear'])
  assert.deepEqual(after.available.map((e) => e.id), ['atlassian', 'github'])
  assert.deepEqual(after.installed.map((e) => e.id), ['linear'])
})

