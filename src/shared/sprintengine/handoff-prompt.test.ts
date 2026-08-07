import assert from 'node:assert/strict'
import { buildPlanFileSprintEngineHandoffPrompt } from './handoff-prompt'

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
  assert.ok(prompt.includes('sprintengine.task.next'), 'auto-run flow names the MCP claim tool')
  assert.ok(!prompt.includes('sprintengine.agent.next_directive'), 'auto-run flow does not route through the directive hop')
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
  assert.ok(prompt.includes('using `{role, id}`'), 'handoff prompt documents the run-context claim payload')
  assert.ok(!prompt.includes('{statePath, role, agentId}'), 'handoff prompt does not document the stale path-bearing directive payload')
  assert.ok(prompt.includes('registered run context'), 'handoff prompt explains managed run-context routing')
  assert.ok(prompt.includes('`sprintengine-studio`'), 'handoff prompt names the public Studio MCP gateway')
  // The shipped sentence, verbatim. `5912ed928` (2026-07-29) shortened "The
  // Multicode app owns runner policy" to "The app owns runner policy" and left
  // this expectation on the old wording, so the suite has been red since.
  assert.ok(prompt.includes('The app owns runner policy'), 'auto-run flow defers runner mode to the app supervisor instead of a CLI command')
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
  assert.ok(prompt.includes('The app owns runner policy'), 'runner policy remains app-owned')
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

function testReferenceFlagFlowsIntoHandoverPayload(): void {
  const base = {
    teamSlug: 'checkout-flow',
    goal: 'Checkout Flow',
    sourcePath: 'backlog/checkout-flow.md',
    sourceContent: '# Checkout Flow\nShip it.',
    sourcePlanKind: 'architect_plan' as const,
    statePath: '.multi-code/sprintengine/checkout-flow/run.yaml',
  }

  const referenced = buildPlanFileSprintEngineHandoffPrompt({ ...base, reference: true })
  assert.ok(referenced.includes('"reference": true'), 'reference launches embed reference:true in the handover payload')
  assert.ok(referenced.includes('read and update it in place'), 'reference guidance tells the agent to edit in place')
  assert.ok(referenced.includes('update them in place rather than copying them'), 'closing guidance is reference-aware')

  const copied = buildPlanFileSprintEngineHandoffPrompt(base)
  assert.ok(!copied.includes('"reference"'), 'non-reference launches omit the reference flag')
  assert.ok(copied.includes('in the Sprint Engine team folder'), 'copy launches keep the team-folder read guidance')
}

function testEpicHandoffReferencesChildrenAndGuidesInPlaceReview(): void {
  const prompt = buildPlanFileSprintEngineHandoffPrompt({
    teamSlug: 'auth-revamp',
    goal: 'Revamp authentication',
    sourcePath: 'backlog/epics/auth-revamp.md',
    sourceContent: '# Auth revamp',
    sourcePlanKind: 'epic',
    reference: true,
    sourceBundle: [
      {
        kind: 'generic_context',
        sourcePath: '/repo/backlog/login-form.md',
        sourceRelativePath: 'backlog/login-form.md',
        sourceContent: '# Login form',
      },
      {
        kind: 'generic_context',
        sourcePath: '/repo/backlog/session-store.md',
        sourceRelativePath: 'backlog/session-store.md',
        sourceContent: '# Session store',
      },
    ],
    statePath: '.multi-code/sprintengine/auth-revamp/run.yaml',
  })

  // The epic is the handover root; its children are the source bundle.
  assert.ok(prompt.includes('"handoverPath": "backlog/epics/auth-revamp.md"'), 'epic file is the handover root')
  assert.ok(prompt.includes('"sourcePlanKind": "epic"'), 'root plan kind is epic')
  assert.ok(prompt.includes('"sourcePath": "backlog/login-form.md"'), 'children are referenced by backlog-relative path')
  assert.ok(prompt.includes('"sourcePath": "backlog/session-store.md"'))
  assert.ok(prompt.includes('"reference": true'), 'epic launches are reference launches')
  assert.ok(prompt.includes('Source type: backlog epic'), 'epic-specific guidance is emitted')
  assert.ok(prompt.includes('plan.md` as a thin manifest'), 'guidance describes the manifest plan.md')
  assert.ok(!prompt.includes('/repo/backlog'), 'epic handoff does not expose absolute child paths')
  assert.ok(!CLI_INSTRUCTION_PATTERN.test(prompt), 'epic handoff does not instruct sprintengine CLI commands')
}

function testReferencedArchitectPlanGetsManifestGuidanceNotSeedGuidance(): void {
  const base = {
    teamSlug: 'checkout-flow',
    goal: 'Checkout Flow',
    sourcePath: 'backlog/checkout-flow.md',
    sourceContent: '# Checkout Flow\nShip it.',
    sourcePlanKind: 'architect_plan' as const,
    statePath: '.multi-code/sprintengine/checkout-flow/run.yaml',
  }

  const referenced = buildPlanFileSprintEngineHandoffPrompt({ ...base, reference: true })
  assert.ok(referenced.includes('implementation plan, referenced in place'), 'reference launch gets the in-place plan guidance')
  assert.ok(referenced.includes('does not seed plan.md'), 'reference guidance states plan.md is not seeded')
  assert.ok(referenced.includes('thin manifest'), 'reference guidance describes the manifest plan.md')
  assert.ok(!referenced.includes('should seed plan.md'), 'reference launch drops the copy-mode seed guidance')

  const copied = buildPlanFileSprintEngineHandoffPrompt(base)
  assert.ok(copied.includes('should seed plan.md'), 'copy launch keeps the seed guidance')
  assert.ok(!copied.includes('referenced in place'), 'copy launch omits the in-place plan guidance')

  // Bundle-shaped launches classify by bundle kind and must branch the same way.
  const bundleReferenced = buildPlanFileSprintEngineHandoffPrompt({
    ...base,
    reference: true,
    sourceBundle: [
      {
        kind: 'architect_plan',
        sourcePath: '/repo/backlog/checkout-flow.md',
        sourceRelativePath: 'backlog/checkout-flow.md',
        sourceContent: '# Checkout Flow',
      },
    ],
  })
  assert.ok(bundleReferenced.includes('implementation plan, referenced in place'), 'reference bundle launch gets the in-place plan guidance')
  assert.ok(!bundleReferenced.includes('should seed plan.md'), 'reference bundle launch drops the seed guidance')
}

function testRolesSentenceUsesConfiguredRolesNotSeats(): void {
  const base = {
    teamSlug: 'checkout-flow',
    goal: 'Checkout Flow',
    sourcePath: 'backlog/checkout-flow.md',
    sourceContent: '# Checkout Flow\nShip it.',
    sourcePlanKind: 'product_plan' as const,
    statePath: '.multi-code/sprintengine/checkout-flow/run.yaml',
  }

  // Lease-era lazy roster: only the planner is seated, but the run's legal
  // role set is wider. The prompt must state the configured roles, or the
  // architect refuses to plan the other roles' work (the
  // sprint-chaining-automations empty-graph regression).
  const prompt = buildPlanFileSprintEngineHandoffPrompt({
    ...base,
    rosterArgs: ['architect:architect'],
    configuredRoles: ['architect', 'developer', 'frontend'],
  })
  assert.ok(
    prompt.includes("Your run's roles are: architect, developer, frontend."),
    'roles sentence lists the configured roles, not the seated planner',
  )
  assert.ok(prompt.includes('"architect:architect"'), 'init payload still carries the seat specs verbatim')

  const seatOnly = buildPlanFileSprintEngineHandoffPrompt({
    ...base,
    rosterArgs: ['architect:architect'],
  })
  assert.ok(
    !seatOnly.includes("Your run's roles are:"),
    'without configuredRoles the sentence is dropped — seats never stand in for the legal role set',
  )
}

function testSeedAlreadyPersistedDropsHandoverStep(): void {
  const base = {
    teamSlug: 'checkout-flow',
    goal: 'Checkout Flow',
    sourcePath: 'backlog/checkout-flow.md',
    sourceContent: '# Checkout Flow\nShip it.',
    sourcePlanKind: 'architect_plan' as const,
    statePath: '.multi-code/sprintengine/checkout-flow/run.yaml',
    reference: true,
  }

  const seeded = buildPlanFileSprintEngineHandoffPrompt({ ...base, seedAlreadyPersisted: true })
  assert.ok(!seeded.includes('Call `sprintengine.handover`'), 'app-seeded prompt drops the handover call instruction')
  assert.ok(!seeded.includes('"handoverPath"'), 'app-seeded prompt drops the handover payload')
  assert.ok(!seeded.includes('Only after `sprintengine.handover` succeeds'), 'app-seeded prompt drops the handover-then-init sequencing')
  assert.ok(seeded.includes('do NOT call `sprintengine.handover`'), 'app-seeded prompt tells the agent not to handover')
  assert.ok(seeded.includes('sprintengine.init'), 'app-seeded prompt still initializes the run')
  assert.ok(seeded.includes('seeded this sprint source'), 'app-seeded prompt states the source is already seeded')

  const notSeeded = buildPlanFileSprintEngineHandoffPrompt({ ...base, seedAlreadyPersisted: false })
  assert.ok(notSeeded.includes('Call `sprintengine.handover`'), 'non-seeded (CLI/copy) prompt keeps the handover call instruction')
  assert.ok(!notSeeded.includes('do NOT call `sprintengine.handover`'), 'non-seeded prompt omits the skip-handover guidance')
}

function testMockupBundleItemsGetTheMockupDirectiveAndRootStaysListed(): void {
  const prompt = buildPlanFileSprintEngineHandoffPrompt({
    teamSlug: 'checkout-flow',
    goal: 'Checkout Flow',
    sourcePath: 'backlog/checkout-flow.md',
    sourceContent: '# Checkout Flow',
    sourcePlanKind: 'product_plan',
    reference: true,
    sourceBundle: [
      {
        kind: 'html_mockup',
        sourcePath: '/repo/backlog/mockups/checkout.html',
        sourceRelativePath: 'backlog/mockups/checkout.html',
        sourceContent: '<h1>Checkout</h1>',
      },
    ],
    statePath: '.multi-code/sprintengine/checkout-flow/run.yaml',
  })

  // The primary markdown source must not vanish from the summary just because
  // a bundle (here: an attached mockup) exists.
  assert.ok(prompt.includes('Source path: `backlog/checkout-flow.md`'), 'root source stays listed alongside the bundle')
  assert.ok(prompt.includes('- html_mockup: `backlog/mockups/checkout.html`'), 'mockup rides the source summary')
  assert.ok(prompt.includes('Attached mockups — the visual contract for product-facing work:'), 'mockup directive is emitted')
  assert.ok(
    prompt.includes('name, inline in its description, the mockup file path and the specific section it implements'),
    'directive requires path + section on every product-facing task card',
  )
  // The card-structure rule text itself lives in the architect workflow skill
  // (one behavior per prompt layer) — the launch directive must not restate it.
  assert.ok(
    !prompt.includes('"Match the mockup" without a path and section is not a reference.'),
    'launch directive does not duplicate the skill-owned card rule',
  )

  const noMockups = buildPlanFileSprintEngineHandoffPrompt({
    teamSlug: 'checkout-flow',
    goal: 'Checkout Flow',
    sourcePath: 'backlog/checkout-flow.md',
    sourceContent: '# Checkout Flow',
    sourcePlanKind: 'product_plan',
    statePath: '.multi-code/sprintengine/checkout-flow/run.yaml',
  })
  assert.ok(!noMockups.includes('Attached mockups'), 'directive is dropped when no mockup is attached')
}

function testSupportOnlyBundleDoesNotReclassifyThePlanSource(): void {
  // A referenced implementation-plan backlog item with an attached mockup must
  // keep the referenced-plan guidance — the mockup bundle is supporting
  // context, not what the sprint is "from".
  const prompt = buildPlanFileSprintEngineHandoffPrompt({
    teamSlug: 'checkout-flow',
    goal: 'Checkout Flow',
    sourcePath: 'backlog/checkout-flow.md',
    sourceContent: '# Checkout Flow',
    sourcePlanKind: 'architect_plan',
    reference: true,
    sourceBundle: [
      {
        kind: 'html_mockup',
        sourcePath: '/repo/backlog/mockups/checkout.html',
        sourceRelativePath: 'backlog/mockups/checkout.html',
        sourceContent: '<h1>Checkout</h1>',
      },
    ],
    statePath: '.multi-code/sprintengine/checkout-flow/run.yaml',
  })

  assert.ok(
    prompt.includes('implementation plan, referenced in place'),
    'attached-mockup launch keeps the referenced-plan guidance',
  )
  assert.ok(
    !prompt.includes('Source bundle type: HTML mockup'),
    'a support-only bundle does not reclassify the launch as mockup-sourced',
  )
}

function testRootSourceLineIsNotDuplicatedWhenRootIsABundleItem(): void {
  // Hand-picked HTML source: the root IS the bundle's only item — one listing.
  const prompt = buildPlanFileSprintEngineHandoffPrompt({
    teamSlug: 'mockup-run',
    goal: 'Mockup run',
    sourcePath: 'mockups/picker.html',
    sourceContent: '<h1>Picker</h1>',
    sourceBundle: [
      {
        kind: 'html_mockup',
        sourcePath: '/repo/mockups/picker.html',
        sourceRelativePath: 'mockups/picker.html',
        sourceContent: '<h1>Picker</h1>',
      },
    ],
    statePath: '.multi-code/sprintengine/mockup-run/run.yaml',
  })

  assert.ok(!prompt.includes('Source path: `mockups/picker.html`'), 'no duplicate root line when the root is a bundle item')
  assert.ok(prompt.includes('- html_mockup: `mockups/picker.html`'), 'the bundle listing carries the source')
}

function main(): void {
  testPlanFileHandoffIsMcpNative()
  testRolesSentenceUsesConfiguredRolesNotSeats()
  testSeedAlreadyPersistedDropsHandoverStep()
  testPlanFileHandoffBundleIssuesOneHandoverCallWithSourceBundle()
  testBacklogHandoffUsesBacklogPathsAndKeepsManagedMcpInvariants()
  testBacklogBundleUsesRelativeBundlePaths()
  testWorktreeModeFlowsIntoInitPayload()
  testReferenceFlagFlowsIntoHandoverPayload()
  testReferencedArchitectPlanGetsManifestGuidanceNotSeedGuidance()
  testEpicHandoffReferencesChildrenAndGuidesInPlaceReview()
  testMockupBundleItemsGetTheMockupDirectiveAndRootStaysListed()
  testSupportOnlyBundleDoesNotReclassifyThePlanSource()
  testRootSourceLineIsNotDuplicatedWhenRootIsABundleItem()
  console.log('handoff-prompt.test.ts: ok')
}

main()
