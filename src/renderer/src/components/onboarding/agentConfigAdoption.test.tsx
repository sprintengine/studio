import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import {
  ADOPTION_MISSING_ROOT_MESSAGE,
  AgentConfigAdoptionStatus,
  describeAdoptionCount,
  planAgentConfigAdoption,
} from './agentConfigAdoption'
import { test } from 'vitest'

test('agentConfigAdoption', async () => {
  let failures = 0
  function run(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  const detected = { mcpServerKeys: ['mcp:codex:a'], skillKeys: ['skill:codex:b'] }

  // --- planAgentConfigAdoption: once per profile, silent, honest on failure ---

  run('a profile that already adopted is never offered it again', () => {
    assert.deepEqual(planAgentConfigAdoption({ hasAdoptedAgentConfig: true, workspaceRoot: '/repo', detected }), {
      kind: 'skip',
    })
  })

  run('a failed or empty detection adopts nothing, silently', () => {
    assert.deepEqual(
      planAgentConfigAdoption({ hasAdoptedAgentConfig: false, workspaceRoot: '/repo', detected: null }),
      {
        kind: 'nothing-detected',
      },
    )
    assert.deepEqual(
      planAgentConfigAdoption({
        hasAdoptedAgentConfig: false,
        workspaceRoot: '/repo',
        detected: { mcpServerKeys: [], skillKeys: [] },
      }),
      { kind: 'nothing-detected' },
    )
  })

  // ORDER MATTERS. The root is only checked once we know there IS something to
  // adopt. Checked first, every user who never had Claude Code or Codex would be
  // told we couldn't bring over a setup they never had.
  run('no root and nothing detected is silent, not a failure', () => {
    const plan = planAgentConfigAdoption({
      hasAdoptedAgentConfig: false,
      workspaceRoot: null,
      detected: { mcpServerKeys: [], skillKeys: [] },
    })
    assert.equal(plan.kind, 'nothing-detected')
  })

  // But a real setup with nowhere to write it IS a failure and says so — silently
  // dropping an adoption is worse than admitting it did not happen.
  run('a real setup with no usable folder fails out loud', () => {
    for (const root of [null, '', '   ']) {
      const plan = planAgentConfigAdoption({ hasAdoptedAgentConfig: false, workspaceRoot: root, detected })
      assert.equal(plan.kind, 'missing-root', `root ${JSON.stringify(root)} is not a usable folder`)
      if (plan.kind !== 'missing-root') throw new Error('unreachable')
      assert.equal(plan.result.status, 'failed')
      assert.equal(plan.result.message, ADOPTION_MISSING_ROOT_MESSAGE)
    }
  })

  run('adopts everything detected against the validated workspace root', () => {
    const plan = planAgentConfigAdoption({
      hasAdoptedAgentConfig: false,
      workspaceRoot: '/repo/app',
      detected,
    })
    assert.deepEqual(plan, {
      kind: 'adopt',
      workspaceRoot: '/repo/app',
      mcpServerKeys: ['mcp:codex:a'],
      skillKeys: ['skill:codex:b'],
    })
  })

  // --- AgentConfigAdoptionStatus: honest, shape-coded success/failure visibility ---

  run('counts read as plain English', () => {
    assert.equal(describeAdoptionCount(1, 'MCP server'), '1 MCP server')
    assert.equal(describeAdoptionCount(0, 'skill'), '0 skills')
    assert.equal(describeAdoptionCount(3, 'skill'), '3 skills')
  })

  run('renders nothing when no adoption ran', () => {
    assert.equal(renderToStaticMarkup(<AgentConfigAdoptionStatus adoption={null} />), '')
  })

  run('shows an in-flight line while adopting', () => {
    const html = renderToStaticMarkup(<AgentConfigAdoptionStatus adoption={{ status: 'adopting' }} />)
    assert.match(html, /Bringing over your existing setup/)
  })

  run('reports the real counts on success', () => {
    const html = renderToStaticMarkup(
      <AgentConfigAdoptionStatus adoption={{ status: 'adopted', mcpServerCount: 2, skillCount: 1, warnings: [] }} />,
    )
    assert.match(html, /Brought over 2 MCP servers and 1 skill\./)
  })

  run('states nothing-adopted as nothing adopted, never as a success', () => {
    const html = renderToStaticMarkup(
      <AgentConfigAdoptionStatus adoption={{ status: 'adopted', mcpServerCount: 0, skillCount: 0, warnings: [] }} />,
    )
    assert.match(html, /Nothing to bring over/)
  })

  run('a failure carries the real message, not a generic apology', () => {
    const html = renderToStaticMarkup(
      <AgentConfigAdoptionStatus adoption={{ status: 'failed', message: 'permission denied' }} />,
    )
    assert.match(html, /Couldn’t bring over your existing setup\./)
    assert.match(html, /permission denied/)
  })

  if (failures > 0) {
    console.error(`${failures} agent-config-adoption test(s) failed`)
    process.exit(1)
  }
  console.log('agent config adoption tests passed')
})
