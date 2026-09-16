import assert from 'node:assert/strict'

import type { MarketplacePluginEntry } from '../../../../shared/marketplace/manifest'
import { componentKindLabels, externalSourceHref } from './storefrontView'

function plugin(overrides: Partial<MarketplacePluginEntry> = {}): MarketplacePluginEntry {
  return {
    id: 'browser-automation-mcp',
    name: 'Browser Automation MCP',
    publisher: { name: 'Multicode Labs', verified: true },
    summary: 'Playwright MCP server for browser inspection and UI automation.',
    category: 'Testing',
    icon: 'icons/browser-automation.svg',
    latest: 1,
    source: 'https://github.com/sprintengine/studio-releases/tree/main/plugins/browser-automation-mcp',
    provides: ['mcp'],
    signature: { algorithm: 'ed25519', publicKey: 'k', signature: 's' },
    ...overrides,
  }
}

{
  // "View source" href guard: http(s) sources pass through unchanged so the
  // link still renders and opens.
  assert.equal(
    externalSourceHref('https://github.com/sprintengine/studio-releases/tree/main/plugins/x'),
    'https://github.com/sprintengine/studio-releases/tree/main/plugins/x',
  )
  assert.equal(externalSourceHref('http://example.com/x'), 'http://example.com/x')
}

{
  // Fail closed: non-http(s) schemes that would reach shell.openExternal render
  // no link. Covers file:// / smb:// / an OS protocol-handler scheme.
  assert.equal(externalSourceHref('file:///etc/passwd'), undefined)
  assert.equal(externalSourceHref('smb://host/share'), undefined)
  assert.equal(externalSourceHref('ms-msdt:/id'), undefined)
  // Missing/absent and unparseable sources also fail closed (inline-MCP entries
  // carry no source and must show no link).
  assert.equal(externalSourceHref(undefined), undefined)
  assert.equal(externalSourceHref('not a url'), undefined)
}

{
  // MC-1531: a module-carrying entry's kind label reads "Module".
  const calendar = plugin({ id: 'multicode-calendar', name: 'Calendar', provides: ['module'] })
  assert.deepEqual(componentKindLabels(calendar.provides), ['Module'])
  assert.deepEqual(componentKindLabels(['mcp', 'skills']), ['MCP server', 'Skill pack'])
}

console.log('storefrontView.test.ts passed')
