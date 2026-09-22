import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { defaultAgent } from '../../../../shared/agent-state'
import { isPlaceholderAgentName } from '../../../../shared/agent-names'
import type { Workspace } from '../../types/workspace'
import { nameGenericWorkspaceAgents } from './normalizers'

test('placeholder detection uses exact record identity and preserves custom labels', () => {
  for (const name of [undefined, null, '', ' ', 'Agent', 'Agent 2', 'A1', 'agent-codex-abc123']) {
    assert.equal(isPlaceholderAgentName(name, 'agent-codex-abc123'), true)
  }
  for (const name of ['Reviewer', 'Agent Smith', 'agent-codex-custom', 'abc123']) {
    assert.equal(isPlaceholderAgentName(name, 'agent-codex-abc123'), false)
  }
})

test('recovery reserves later recovered names before choosing unique replacements and is idempotent', () => {
  const random = vi.spyOn(Math, 'random').mockReturnValue(0)
  try {
    const input = [
      {
        id: 'ws',
        agents: {
          missing: { ...defaultAgent('missing'), name: undefined },
          recovered: defaultAgent('recovered'),
          custom: defaultAgent('custom', 'Reviewer'),
        },
      } as unknown as Workspace,
    ]
    const result = nameGenericWorkspaceAgents(input, (_workspaceId, agentId) =>
      agentId === 'recovered' ? 'Aed Ahern' : undefined,
    )
    assert.equal(result[0].agents.recovered.name, 'Aed Ahern')
    assert.equal(result[0].agents.missing.name, 'Aidan Ahern')
    assert.equal(result[0].agents.custom, input[0].agents.custom)
    assert.equal(nameGenericWorkspaceAgents(result), result)
    assert.equal(input[0].agents.recovered.name, 'recovered')
  } finally {
    random.mockRestore()
  }
})
