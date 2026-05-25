type PlanFileSprintEngineHandoffPromptArgs = {
  teamSlug: string
  goal: string
  sourcePath: string
  sourceContent: string
  sourcePlanKind?: string
  sourceBundle?: Array<{
    kind: string
    sourcePath: string
    sourceRelativePath?: string
    sourceContent: string
  }>
  statePath: string
  rosterArgs?: string[]
  autoRunRequested?: boolean
}

function jsonBlock(payload: Record<string, unknown>): string {
  return ['```json', JSON.stringify(payload, null, 2), '```'].join('\n')
}

function sourceTypeGuidance(
  hasExplicitSourceBundle: boolean,
  bundle: Array<{ kind: string }>,
  sourcePlanKind: string,
): string {
  if (hasExplicitSourceBundle) {
    const kinds = Array.from(new Set(bundle.map((item) => item.kind)))
    if (kinds.length === 1) {
      const kind = kinds[0]
      if (kind === 'html_mockup') {
        return 'Source bundle type: HTML mockup. `sprintengine.init` should route the source to product and architect review as context. The reviewers should use it to clarify intent with the user, then create product requirements and an implementation plan before execution.'
      }
      if (kind === 'product_plan') {
        return 'Source bundle type: product plan. `sprintengine.init` should seed product-requirements.md for review. A rostered product strategist should review and update it instead of recreating the same product plan.'
      }
      if (kind === 'architect_plan') {
        return 'Source bundle type: implementation plan. `sprintengine.init` should seed plan.md for architect review. The architect should review it against the current codebase, update stale details, mark it ready for user approval, then create task cards.'
      }
      if (kind === 'design_notes') {
        return 'Source bundle type: design notes. `sprintengine.init` should route the source to product and architect review as design context, and relevant UI tasks should reference it in implementation notes.'
      }
      if (kind === 'generic_context' || kind === 'unknown') {
        return 'Source bundle type: context. `sprintengine.init` should route the source to product and architect review as incoming context. Reviewers should clarify intent with the user before turning it into requirements, an implementation plan, and task cards.'
      }
    }
    if (kinds.includes('product_plan') || kinds.includes('architect_plan')) {
      return 'Source bundle type: mixed sources. `sprintengine.init` should seed canonical files from product and implementation plan sources when present, preserve source edits on rerun, and route review work to rostered specialists before execution planning continues.'
    }
    return 'Source bundle type: mixed context sources. `sprintengine.init` should route the sources to product and architect review as mockup, design, and context input. Reviewers should clarify intent with the user before turning it into requirements, an implementation plan, and task cards.'
  }

  if (sourcePlanKind === 'product_plan') {
    return 'Source plan type: product plan. `sprintengine.init` should seed product-requirements.md for review. A rostered product strategist should review and update it instead of recreating the same product plan.'
  }
  if (sourcePlanKind === 'architect_plan') {
    return 'Source plan type: implementation plan. `sprintengine.init` should seed plan.md for architect review. The architect should review it against the current codebase, update stale details, then create task cards.'
  }
  return 'Source plan type: generic handoff. Sprint Engine should use the normal product intake and architect planning gates.'
}

export function buildPlanFileSprintEngineHandoffPrompt({
  teamSlug,
  goal,
  sourcePath,
  sourceContent,
  sourcePlanKind = 'unknown',
  sourceBundle = [],
  rosterArgs = [],
  autoRunRequested = false,
}: PlanFileSprintEngineHandoffPromptArgs): string {
  const hasExplicitSourceBundle = sourceBundle.length > 0
  const bundle = hasExplicitSourceBundle
    ? sourceBundle
    : [{ kind: sourcePlanKind, sourcePath, sourceContent }]
  const contentLines = bundle.reduce((sum, item) => sum + item.sourceContent.trim().split(/\r?\n/).length, 0)
  const sourceSummary = hasExplicitSourceBundle
    ? bundle.map((item) => `- ${item.kind}: \`${item.sourcePath}\``).join('\n')
    : `Source path: \`${sourcePath}\``

  const handoverCalls = hasExplicitSourceBundle
    ? [
      'Call `sprintengine.handover` once per source in the bundle, passing `handoverPath` and `sourcePlanKind` for each. Stop and report to the user if any call reports a collision or failure:',
      bundle.map((item) => jsonBlock({
        name: teamSlug,
        goal,
        handoverPath: item.sourcePath,
        sourcePlanKind: item.kind,
      })).join('\n'),
    ].join('\n\n')
    : [
      'Call `sprintengine.handover` with the selected markdown source:',
      jsonBlock({
        name: teamSlug,
        goal,
        handoverPath: sourcePath,
        sourcePlanKind,
      }),
    ].join('\n')

  const initPayload: Record<string, unknown> = {
    goal,
  }
  if (rosterArgs.length > 0) initPayload.agent = rosterArgs

  const architectJoinPayload = {
    role: 'architect',
    agentId: 'architect',
  }
  const architectDirectivePayload = {
    role: 'architect',
    agentId: 'architect',
  }

  return [
    hasExplicitSourceBundle
      ? 'Create a Sprint Engine workspace from this saved source bundle through the managed Sprint Engine MCP server.'
      : 'Create a Sprint Engine workspace from this saved future plan through the managed Sprint Engine MCP server.',
    `Team name: \`${teamSlug}\``,
    `Goal: ${goal}`,
    sourceSummary,
    `Source snapshot: ${contentLines} total text line${contentLines === 1 ? '' : 's'} selected by the user.`,
    'The renderer has only created local workspace metadata and this startup prompt. Canonical Sprint Engine files must be created by the managed `multicode-sprintengine` MCP server, which resolves run and workspace routing from its registered HTTP run context. Do not pass server-owned routing fields in autonomous MCP tool payloads. Do not write run-store files, `handover.md`, task state, or artifact state directly. Do not run `sprintengine` shell commands for autonomous Sprint Engine work — the CLI is reserved for human and debug operators.',
    handoverCalls,
    'Only after `sprintengine.handover` succeeds, initialize the Sprint Engine state for this managed session:',
    '`sprintengine.init`',
    jsonBlock(initPayload),
    rosterArgs.length > 0
      ? `Roster constraint: the architect must create tasks only for these selected Sprint Engine agents: ${rosterArgs.join(', ')}. If a specialist role is absent from this roster, do not create tasks for that role.`
      : null,
    sourceTypeGuidance(hasExplicitSourceBundle, bundle, sourcePlanKind),
    autoRunRequested
      ? [
        'Auto-run was requested when this workspace was created. The Multicode app owns runner policy and will persist `auto` mode through its supervisor IPC immediately after `sprintengine.init` returns — you do not need to set runner mode from this terminal.',
        'After `sprintengine.init` succeeds, continue immediately into the architect MCP join + directive flow for this same run.',
        'Register as the architect agent with `sprintengine.agent.join`:',
        jsonBlock(architectJoinPayload),
        'Then request the structured directive with `sprintengine.agent.next_directive`:',
        jsonBlock(architectDirectivePayload),
        'Invoke the returned `nextMcpToolName` with `nextMcpArguments` verbatim. `sprintengine.init` only creates the first architect task; the directive tool will route the assignment.',
      ].join('\n\n')
      : null,
    'After initialization, agents continue through the managed MCP server: register with `sprintengine.agent.join`, then call `sprintengine.agent.next_directive` with `{role, agentId}` to receive the next directive. The directive payload names `nextMcpToolName` and `nextMcpArguments` for the next claim — implementation task, quality gate, or `needs_input` triage. Product and architect agents must read the imported source file(s) in the Sprint Engine team folder when their own work is claimed, and should treat those files as incoming context.',
  ].filter((line): line is string => line !== null).join('\n\n')
}
