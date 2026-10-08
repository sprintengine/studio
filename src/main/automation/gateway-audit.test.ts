import assert from 'node:assert/strict'
import { test } from 'vitest'

import { isAuditedCall, TAILNET_PEER_REFUSED_AUDIT_TOOL } from './gateway-audit'
import { isStudioGatewayMutation } from './studio-gateway-tools'

// What the gateway's one audit keeps: mutations, a token refused at the door,
// and never a visit, which a device stamps every few seconds a chat is on screen.

test('a visit is a mutation on the tailnet, and is kept out of the audit, allowed or refused', () => {
  assert.equal(isStudioGatewayMutation('conversation.visit'), true, 'it still needs conversation:operate')
  assert.equal(isAuditedCall('conversation.visit', true), false)
})

test('the other lifecycle tools and every other mutation are still audited, and reads are not', () => {
  for (const tool of ['conversation.settle', 'conversation.mark_unread', 'conversation.create'])
    assert.equal(isAuditedCall(tool, isStudioGatewayMutation(tool)), true, tool)
  assert.equal(isAuditedCall('workspace.list', isStudioGatewayMutation('workspace.list')), false)
  assert.equal(isAuditedCall(TAILNET_PEER_REFUSED_AUDIT_TOOL, false), true, 'a refusal at the door is kept')
})
