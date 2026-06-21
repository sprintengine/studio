import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import {
  ADOPTION_MISSING_ROOT_MESSAGE,
  AgentConfigAdoptionStatus,
  planDeferredAdoption,
} from './agentConfigAdoption'

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

const selection = { mcpServerKeys: ['mcp:codex:a'], skillKeys: ['skill:codex:b'] }

// --- planDeferredAdoption: the post-create decision (skip / missing-root / adopt) ---

run('skips when onboarding is already complete', () => {
  assert.deepEqual(
    planDeferredAdoption({ onboardingStep: 'complete', selection, workspaceRoot: '/repo' }),
    { kind: 'skip' },
  )
})

run('skips when there is no selection — the "Skip for now" path never adopts', () => {
  // EssentialsStep clears pendingAgentConfigAdoption on skip, so the hook sees null.
  assert.deepEqual(
    planDeferredAdoption({ onboardingStep: 'workspace', selection: null, workspaceRoot: '/repo' }),
    { kind: 'skip' },
  )
})

run('skips when the selection is empty', () => {
  assert.deepEqual(
    planDeferredAdoption({
      onboardingStep: 'workspace',
      selection: { mcpServerKeys: [], skillKeys: [] },
      workspaceRoot: '/repo',
    }),
    { kind: 'skip' },
  )
})

run('fails honestly when a selection exists but the workspace has no folder', () => {
  for (const workspaceRoot of [null, '', '   ']) {
    const plan = planDeferredAdoption({ onboardingStep: 'workspace', selection, workspaceRoot })
    assert.equal(plan.kind, 'missing-root')
    assert.equal(plan.kind === 'missing-root' && plan.result.status, 'failed')
    assert.equal(plan.kind === 'missing-root' && plan.result.message, ADOPTION_MISSING_ROOT_MESSAGE)
  }
})

run('adopts the selected keys against the validated workspace root', () => {
  const plan = planDeferredAdoption({ onboardingStep: 'first-run', selection, workspaceRoot: '/repo/app' })
  assert.deepEqual(plan, {
    kind: 'adopt',
    workspaceRoot: '/repo/app',
    mcpServerKeys: ['mcp:codex:a'],
    skillKeys: ['skill:codex:b'],
  })
})

// --- AgentConfigAdoptionStatus: honest, shape-coded success/failure visibility ---

run('renders nothing when no adoption ran', () => {
  assert.equal(renderToStaticMarkup(<AgentConfigAdoptionStatus adoption={null} />), '')
})

run('shows an in-flight line while adopting', () => {
  const html = renderToStaticMarkup(<AgentConfigAdoptionStatus adoption={{ status: 'adopting' }} />)
  assert.match(html, /Bringing over your existing setup/)
})

run('shows real counts on success', () => {
  const html = renderToStaticMarkup(
    <AgentConfigAdoptionStatus adoption={{ status: 'adopted', mcpServerCount: 2, skillCount: 1, warnings: [] }} />,
  )
  assert.match(html, /Brought over 2 MCP servers and 1 skill\./)
})

run('is honest when nothing was actually adopted', () => {
  const html = renderToStaticMarkup(
    <AgentConfigAdoptionStatus adoption={{ status: 'adopted', mcpServerCount: 0, skillCount: 0, warnings: [] }} />,
  )
  assert.match(html, /Nothing to bring over/)
})

run('surfaces the real failure message and any warnings — never a fake success', () => {
  const html = renderToStaticMarkup(
    <AgentConfigAdoptionStatus
      adoption={{ status: 'failed', message: 'disk write blocked' }}
    />,
  )
  assert.match(html, /Couldn.t bring over your existing setup/)
  assert.match(html, /disk write blocked/)
  assert.doesNotMatch(html, /Brought over/)

  const withWarnings = renderToStaticMarkup(
    <AgentConfigAdoptionStatus
      adoption={{ status: 'adopted', mcpServerCount: 1, skillCount: 0, warnings: ['skipped duplicate server'] }}
    />,
  )
  assert.match(withWarnings, /skipped duplicate server/)
})

if (failures > 0) {
  console.error(`agentConfigAdoption.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('agentConfigAdoption.test.tsx: ok')
