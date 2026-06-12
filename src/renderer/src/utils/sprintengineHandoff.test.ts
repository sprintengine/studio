import assert from 'node:assert/strict'
import { buildPlanFileSprintEngineHandoffPrompt } from './sprintengineHandoff'

const CLI_INSTRUCTION_PATTERN = /sprintengine (join|task|gate|triage|init|handover)/

function testPlanFileHandoffIsMcpNative(): void {
  const prompt = buildPlanFileSprintEngineHandoffPrompt({
    teamSlug: 'mcp-runtime',
    goal: 'Ship MCP runtime',
    sourcePath: 'future-plans/2026-05-23-mcp-runtime.md',
    sourceContent: 'line1\nline2\nline3',
    sourcePlanKind: 'architect_plan',
    statePath: '.multi-code/sprintengine/mcp-runtime/run.yaml',
    rosterArgs: ['frontend:frontend', 'developer:developer-1'],
    autoRunRequested: true,
  })

  assert.ok(prompt.includes('managed Sprint Engine MCP server'))
  assert.ok(prompt.includes('sprintengine.handover'), 'plan-file handoff names the MCP handover tool')
  assert.ok(prompt.includes('sprintengine.init'), 'plan-file handoff names the MCP init tool')
  assert.ok(prompt.includes('sprintengine.agent.join'), 'auto-run flow names the MCP join tool')
  assert.ok(prompt.includes('sprintengine.agent.next_directive'), 'auto-run flow names the MCP directive tool')
  assert.ok(!prompt.includes('.multi-code/sprintengine/mcp-runtime/run.yaml'), 'handoff prompt does not expose the run state path')
  assert.ok(!prompt.includes('statePath'), 'handoff prompt does not expose statePath')
  assert.ok(!prompt.includes('workspaceRoot'), 'handoff prompt does not expose workspaceRoot')
  assert.ok(prompt.includes('"name": "mcp-runtime"'), 'handover payload embeds the team name')
  assert.ok(prompt.includes('"handoverPath": "future-plans/2026-05-23-mcp-runtime.md"'), 'handover payload references the source path')
  assert.ok(prompt.includes('"sourcePlanKind": "architect_plan"'), 'handover payload classifies the source plan kind')
  assert.ok(prompt.includes('"goal": "Ship MCP runtime"'))
  assert.ok(prompt.includes('"agent"'), 'init payload includes the roster')
  assert.ok(prompt.includes('"frontend:frontend"'), 'roster preserves agent specs verbatim')
  assert.ok(prompt.includes('"role": "architect"'), 'auto-run flow joins as architect')
  assert.ok(prompt.includes('"agentId": "architect"'), 'auto-run flow uses the architect agent id')
  assert.ok(prompt.includes('with `{role, agentId}`'), 'handoff prompt documents the run-context directive payload')
  assert.ok(!prompt.includes('{statePath, role, agentId}'), 'handoff prompt does not document the stale path-bearing directive payload')
  assert.ok(prompt.includes('registered HTTP run context'), 'handoff prompt explains managed run-context routing')
  assert.ok(prompt.includes('Multicode app owns runner policy'), 'auto-run flow defers runner mode to the app supervisor instead of a CLI command')
  assert.ok(
    !CLI_INSTRUCTION_PATTERN.test(prompt),
    'plan-file handoff does not instruct the agent to run any sprintengine CLI command'
  )
}

function testPlanFileHandoffBundleIssuesOneHandoverCallWithSourceBundle(): void {
  const prompt = buildPlanFileSprintEngineHandoffPrompt({
    teamSlug: 'mcp-runtime',
    goal: 'Ship MCP runtime',
    sourcePath: 'future-plans/2026-05-23-mcp-runtime.md',
    sourceContent: 'unused fallback',
    sourceBundle: [
      { kind: 'product_plan', sourcePath: 'future-plans/product.md', sourceContent: 'p1\np2' },
      { kind: 'architect_plan', sourcePath: 'future-plans/plan.md', sourceContent: 'a1\na2\na3' },
    ],
    statePath: '.multi-code/sprintengine/mcp-runtime/run.yaml',
  })

  assert.ok(prompt.includes('once with the selected markdown source and the complete source bundle'), 'bundle handoff uses one bootstrap call')
  assert.ok(prompt.includes('"handoverPath": "future-plans/2026-05-23-mcp-runtime.md"'), 'bundle handoff imports the selected source as the manifest')
  assert.ok(prompt.includes('"sourceBundle"'), 'bundle handoff includes a structured source bundle')
  assert.ok(prompt.includes('"sourcePath": "future-plans/product.md"'), 'bundle handoff includes the product source')
  assert.ok(prompt.includes('"kind": "product_plan"'), 'bundle handoff classifies the product source')
  assert.ok(prompt.includes('"sourcePath": "future-plans/plan.md"'), 'bundle handoff includes the architect source')
  assert.ok(prompt.includes('"kind": "architect_plan"'), 'bundle handoff classifies the architect source')
  assert.ok(!prompt.includes('statePath'), 'bundle handoff prompt does not expose statePath')
  assert.ok(!prompt.includes('workspaceRoot'), 'bundle handoff prompt does not expose workspaceRoot')
  assert.ok(
    !CLI_INSTRUCTION_PATTERN.test(prompt),
    'bundle handoff does not instruct the agent to run any sprintengine CLI command'
  )
}

function testBacklogHandoffUsesBacklogPathsAndKeepsManagedMcpInvariants(): void {
  const prompt = buildPlanFileSprintEngineHandoffPrompt({
    teamSlug: 'checkout-flow',
    goal: 'Checkout Flow',
    sourcePath: 'backlog/checkout-flow.md',
    sourceContent: '# Checkout Flow\nShip it.',
    sourcePlanKind: 'product_plan',
    statePath: '.multi-code/sprintengine/checkout-flow/run.yaml',
    autoRunRequested: true,
  })

  assert.ok(prompt.includes('saved source plan'), 'single-source copy is Backlog/source-plan oriented')
  assert.ok(prompt.includes('"handoverPath": "backlog/checkout-flow.md"'), 'handover path uses backlog relative path')
  assert.ok(!prompt.includes('future plan'), 'active runtime copy no longer says future plan')
  assert.ok(!prompt.includes('future-plans/'), 'backlog handoff does not rewrite to legacy future-plans paths')
  assert.ok(!prompt.includes('.multi-code/sprintengine/checkout-flow/run.yaml'), 'backlog handoff does not expose the run state path')
  assert.ok(!prompt.includes('statePath'), 'backlog handoff does not expose statePath')
  assert.ok(!prompt.includes('workspaceRoot'), 'backlog handoff does not expose workspaceRoot')
  assert.ok(!CLI_INSTRUCTION_PATTERN.test(prompt), 'backlog handoff does not instruct the agent to run sprintengine CLI commands')
  assert.ok(prompt.includes('Multicode app owns runner policy'), 'runner policy remains app-owned')
}

function testBacklogBundleUsesRelativeBundlePaths(): void {
  const prompt = buildPlanFileSprintEngineHandoffPrompt({
    teamSlug: 'checkout-flow',
    goal: 'Checkout Flow',
    sourcePath: 'backlog/product.md',
    sourceContent: 'unused fallback',
    sourcePlanKind: 'product_plan',
    sourceBundle: [
      {
        kind: 'html_mockup',
        sourcePath: '/repo/backlog/mockup.html',
        sourceRelativePath: 'backlog/mockup.html',
        sourceContent: '<h1>Checkout</h1>',
      },
      {
        kind: 'product_plan',
        sourcePath: '/repo/backlog/product.md',
        sourceRelativePath: 'backlog/product.md',
        sourceContent: '# Checkout Flow',
      },
    ],
    statePath: '.multi-code/sprintengine/checkout-flow/run.yaml',
  })

  assert.ok(prompt.includes('"handoverPath": "backlog/product.md"'), 'bundle manifest uses selected backlog source')
  assert.ok(prompt.includes('"sourcePath": "backlog/mockup.html"'), 'bundle uses backlog-relative mockup source path')
  assert.ok(prompt.includes('"sourcePath": "backlog/product.md"'), 'bundle uses backlog-relative product source path')
  assert.ok(!prompt.includes('/repo/backlog'), 'bundle handoff does not expose absolute selected source paths')
  assert.ok(!prompt.includes('statePath'), 'bundle handoff prompt does not expose statePath')
  assert.ok(!prompt.includes('workspaceRoot'), 'bundle handoff prompt does not expose workspaceRoot')
  assert.ok(!CLI_INSTRUCTION_PATTERN.test(prompt), 'bundle handoff does not instruct the agent to run any sprintengine CLI command')
}

function testWorktreeModeFlowsIntoInitPayload(): void {
  const base = {
    teamSlug: 'checkout-flow',
    goal: 'Checkout Flow',
    sourcePath: 'backlog/checkout-flow.md',
    sourceContent: '# Checkout Flow\nShip it.',
    sourcePlanKind: 'product_plan',
    statePath: '.multi-code/sprintengine/checkout-flow/run.yaml',
  }

  const withWorktrees = buildPlanFileSprintEngineHandoffPrompt({ ...base, useWorktrees: true })
  assert.ok(
    withWorktrees.includes('"useWorktrees": true'),
    'worktree mode requested at creation reaches the architect init payload',
  )

  const withoutWorktrees = buildPlanFileSprintEngineHandoffPrompt(base)
  assert.ok(
    !withoutWorktrees.includes('useWorktrees'),
    'init payload omits useWorktrees when worktree mode was not requested',
  )
}

function main(): void {
  testPlanFileHandoffIsMcpNative()
  testPlanFileHandoffBundleIssuesOneHandoverCallWithSourceBundle()
  testBacklogHandoffUsesBacklogPathsAndKeepsManagedMcpInvariants()
  testBacklogBundleUsesRelativeBundlePaths()
  testWorktreeModeFlowsIntoInitPayload()
  console.log('sprintengineHandoff.test.ts: ok')
}

main()
