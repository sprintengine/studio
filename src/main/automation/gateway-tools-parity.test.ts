import assert from 'node:assert/strict'
import { test } from 'vitest'

import { desktopGatewayTools } from './desktop-gateway-tools'
import { createStudioGatewayTools } from './studio-gateway-tools'
import { desktopToolParts, gatewayToolsFixture, listsFor } from './gateway-tools-parity.test-helper'

// Parity test 1 of the client-tools spec (11.2): the tools/list agents see
// from the desktop, recorded from the in-process composition.

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
