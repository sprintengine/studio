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
  assert.ok(prompt.includes('"statePath": ".multi-code/sprintengine/mcp-runtime/run.yaml"'), 'handover payload embeds the project-relative statePath')
  assert.ok(prompt.includes('"name": "mcp-runtime"'), 'handover payload embeds the team name')
  assert.ok(prompt.includes('"handoverPath": "future-plans/2026-05-23-mcp-runtime.md"'), 'handover payload references the source path')
  assert.ok(prompt.includes('"sourcePlanKind": "architect_plan"'), 'handover payload classifies the source plan kind')
  assert.ok(prompt.includes('"goal": "Ship MCP runtime"'))
  assert.ok(prompt.includes('"agent"'), 'init payload includes the roster')
  assert.ok(prompt.includes('"frontend:frontend"'), 'roster preserves agent specs verbatim')
  assert.ok(prompt.includes('"role": "architect"'), 'auto-run flow joins as architect')
  assert.ok(prompt.includes('Multicode app owns runner policy'), 'auto-run flow defers runner mode to the app supervisor instead of a CLI command')
  assert.ok(
    !CLI_INSTRUCTION_PATTERN.test(prompt),
    'plan-file handoff does not instruct the agent to run any sprintengine CLI command'
  )
}

function testPlanFileHandoffBundleIssuesOneHandoverCallPerSource(): void {
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

  assert.ok(prompt.includes('"handoverPath": "future-plans/product.md"'), 'bundle handoff emits one handover call per source (product)')
  assert.ok(prompt.includes('"sourcePlanKind": "product_plan"'), 'bundle handoff classifies the product source')
  assert.ok(prompt.includes('"handoverPath": "future-plans/plan.md"'), 'bundle handoff emits one handover call per source (architect)')
  assert.ok(prompt.includes('"sourcePlanKind": "architect_plan"'), 'bundle handoff classifies the architect source')
  assert.ok(
    !CLI_INSTRUCTION_PATTERN.test(prompt),
    'bundle handoff does not instruct the agent to run any sprintengine CLI command'
  )
}

function main(): void {
  testPlanFileHandoffIsMcpNative()
  testPlanFileHandoffBundleIssuesOneHandoverCallPerSource()
  console.log('sprintengineHandoff.test.ts: ok')
}

main()
