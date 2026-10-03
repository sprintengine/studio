import assert from 'node:assert/strict'
import { test } from 'vitest'

import { desktopGatewayTools } from './desktop-gateway-tools'
import { createStudioGatewayTools } from './studio-gateway-tools'
import {
  desktopToolParts,
  gatewayToolsFixture,
  listsFor,
  readGatewayToolsFixture,
} from './gateway-tools-parity.test-helper'
import { createClientToolLoop } from './client-tool-loop.test-helper'

// Parity tests 1 and 3 of the client-tools spec (11.2): the tools/list agents
// see from the desktop, recorded from the in-process composition and listed
// the same once the shell offers its toolsets over its port; and an agent
// that lists while the app starts gets the shell's tools on its first list.

test('the desktop’s in-process composition lists exactly the recorded tools', async () => {
  const parts = desktopToolParts()
  const resolve = createStudioGatewayTools({
    appTools: desktopGatewayTools(parts)(parts.core),
    resolveModuleTools: () => [],
    isModuleEnabled: () => false,
  })
  const lists = await listsFor(() => resolve())
  assert.deepEqual(lists, gatewayToolsFixture(lists))
})

test('the shell’s browser and canvas, offered over its port, list exactly the recorded tools', async () => {
  const parts = desktopToolParts()
  const ownTools = createStudioGatewayTools({
    appTools: desktopGatewayTools({ ...parts, browser: [], canvas: [] })(parts.core),
    resolveModuleTools: () => [],
    isModuleEnabled: () => false,
  })()
  const loop = await createClientToolLoop({
    toolsets: [
      { name: 'browser', registrations: parts.browser },
      { name: 'canvas', registrations: parts.canvas },
    ],
    ownTools,
  })
  try {
    const lists = await listsFor(loop.resolveTools)
    assert.deepEqual(lists, readGatewayToolsFixture())
  } finally {
    await loop.close()
  }
})

test('an agent listing while the app starts gets the shell’s tools on its first tools/list', async () => {
  const parts = desktopToolParts()
  const loop = await createClientToolLoop({
    // Offered canvas first, as a slower shell might: the list keeps the order agents know.
    toolsets: [
      { name: 'canvas', registrations: parts.canvas },
      { name: 'browser', registrations: parts.browser },
    ],
    expect: ['browser', 'canvas'],
    deferStart: true,
  })
  try {
    const context = { metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1', agentId: 'agent-1' } }
    const listing = loop.dispatcher.dispatch('tools/list', {}, context)
    await new Promise((resolve) => setTimeout(resolve, 50))
    void loop.start()
    const outcome = await listing
    const names =
      outcome.kind === 'result' ? (outcome.value.tools as Array<{ name: string }>).map((tool) => tool.name) : []
    assert.deepEqual(
      names,
      [...parts.browser, ...parts.canvas].map((tool) => tool.name),
    )
  } finally {
    await loop.close()
  }
})
