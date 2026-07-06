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
  useWorktrees?: boolean
  // When true, the markdown source and every bundle item are handed over as
  // project-root-relative references (no copy into the run store). Used for
  // backlog-sourced sprints so the canonical design docs stay authoritative and
  // are reviewed/updated in place.
  reference?: boolean
  // When true, the Multicode app already seeded the source into run.yaml and ran
  // init at workspace creation, so the architect prompt drops the handover step:
  // a second handover errors ("Team already has bootstrap files") and confuses
  // the agent. CLI/headless starts (which build their own prompt in Python) and
  // copy-mode app paths keep the handover step.
  seedAlreadyPersisted?: boolean
}

function jsonBlock(payload: Record<string, unknown>): string {
  return ['```json', JSON.stringify(payload, null, 2), '```'].join('\n')
}

function sourceTypeGuidance(
  hasExplicitSourceBundle: boolean,
  bundle: Array<{ kind: string }>,
  sourcePlanKind: string,
): string {
  if (sourcePlanKind === 'epic') {
    return [
      'Source type: backlog epic. The epic and its child design documents (the source bundle) are the canonical plan — they are referenced in place, not copied.',
      '`sprintengine.init` mints a plan task to review these designs against the current codebase. As the architect: read the epic and every child document, verify each against the current code, and update stale or incomplete design content in those backlog files themselves (in worktree-mode runs, edit the worktree copies so the updates ride the pull request).',
      'Then write `plan.md` as a thin manifest that references each source document by project-root-relative path with a per-document verification note, and build the full task graph covering every child item. Do not re-author valid design prose into plan.md.',
    ].join('\n\n')
  }
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
  return 'Source plan type: generic handoff. The sprint should use the normal product intake and architect planning gates.'
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
  useWorktrees = false,
  reference = false,
  seedAlreadyPersisted = false,
}: PlanFileSprintEngineHandoffPromptArgs): string {
  const hasExplicitSourceBundle = sourceBundle.length > 0
  const bundle = hasExplicitSourceBundle
    ? sourceBundle
    : [{ kind: sourcePlanKind, sourcePath, sourceContent }]
  const contentLines = bundle.reduce((sum, item) => sum + item.sourceContent.trim().split(/\r?\n/).length, 0)
  const sourceSummary = hasExplicitSourceBundle
    ? bundle.map((item) => `- ${item.kind}: \`${item.sourceRelativePath ?? item.sourcePath}\``).join('\n')
    : `Source path: \`${sourcePath}\``

  const handoverCalls = hasExplicitSourceBundle
    ? [
      reference
        ? 'Call `sprintengine.handover` once with the selected markdown source and the complete source bundle. `reference: true` records every source as a project-root-relative reference to the canonical original (no copy) — read and update those files in place. Stop and report to the user if the call reports a collision or failure:'
        : 'Call `sprintengine.handover` once with the selected markdown source and the complete source bundle. Stop and report to the user if the call reports a collision or failure:',
      jsonBlock({
        name: teamSlug,
        goal,
        handoverPath: sourcePath,
        sourcePlanKind,
        ...(reference ? { reference: true } : {}),
        sourceBundle: bundle.map((item) => ({
          kind: item.kind,
          sourcePath: item.sourceRelativePath ?? item.sourcePath,
        })),
      }),
    ].join('\n\n')
    : [
      reference
        ? 'Call `sprintengine.handover` with the selected markdown source. `reference: true` records it as a project-root-relative reference to the canonical original (no copy) — read and update it in place:'
        : 'Call `sprintengine.handover` with the selected markdown source:',
      jsonBlock({
        name: teamSlug,
        goal,
        handoverPath: sourcePath,
        sourcePlanKind,
        ...(reference ? { reference: true } : {}),
      }),
    ].join('\n')

  const initPayload: Record<string, unknown> = {
    goal,
  }
  if (rosterArgs.length > 0) initPayload.agent = rosterArgs
  // Worktree mode is decided at workspace creation. The architect's init call
  // creates (or reuses) the one shared run worktree + branch, so dropping this
  // flag here would silently disable worktree mode for plan-sourced runs.
  if (useWorktrees) initPayload.useWorktrees = true

  const architectJoinPayload = {
    role: 'architect',
    agentId: 'architect',
  }
  const architectClaimPayload = {
    role: 'architect',
    id: 'architect',
  }

  return [
    hasExplicitSourceBundle
      ? 'Create a Sprint Engine workspace from this saved source bundle through the managed Sprint Engine MCP server.'
      : 'Create a Sprint Engine workspace from this saved source plan through the managed Sprint Engine MCP server.',
    `Team name: \`${teamSlug}\``,
    `Goal: ${goal}`,
    sourceSummary,
    `Source snapshot: ${contentLines} total text line${contentLines === 1 ? '' : 's'} selected by the user.`,
    seedAlreadyPersisted
      ? 'The Multicode app has already created the run store and seeded this sprint source. The remaining canonical Sprint Engine files (product requirements, plan, task cards) are still created by the managed `multicode-sprintengine` MCP server, which resolves run and workspace routing from its registered HTTP run context. Do not pass server-owned routing fields in autonomous MCP tool payloads. Do not write run-store files, `handover.md`, task state, or artifact state directly. The source is already registered — do NOT call `sprintengine.handover`.'
      : 'The renderer has only created local workspace metadata and this startup prompt. Canonical Sprint Engine files must be created by the managed `multicode-sprintengine` MCP server, which resolves run and workspace routing from its registered HTTP run context. Do not pass server-owned routing fields in autonomous MCP tool payloads. Do not write run-store files, `handover.md`, task state, or artifact state directly.',
    seedAlreadyPersisted ? null : handoverCalls,
    seedAlreadyPersisted
      ? 'Initialize the sprint state for this managed session:'
      : 'Only after `sprintengine.handover` succeeds, initialize the sprint state for this managed session:',
    '`sprintengine.init`',
    jsonBlock(initPayload),
    rosterArgs.length > 0
      ? `Roster constraint: the architect must create tasks only for these selected sprint agents: ${rosterArgs.join(', ')}. If a specialist role is absent from this roster, do not create tasks for that role.`
      : null,
    sourceTypeGuidance(hasExplicitSourceBundle, bundle, sourcePlanKind),
    autoRunRequested
      ? [
        'Auto-run was requested when this workspace was created. The Multicode app owns runner policy and will persist `auto` mode through its supervisor IPC immediately after `sprintengine.init` returns — you do not need to set runner mode from this terminal.',
        'After `sprintengine.init` succeeds, continue immediately into the architect MCP join + claim flow for this same run.',
        'Register as the architect agent with `sprintengine.agent.join`:',
        jsonBlock(architectJoinPayload),
        'Then claim the first architect task with `sprintengine.task.next`:',
        jsonBlock(architectClaimPayload),
        'Work what the claim returns. `sprintengine.init` creates the first architect task; if the claim returns no work, reply that no work was claimed and stop.',
      ].join('\n\n')
      : null,
    reference
      ? 'After initialization, agents continue through the managed MCP server: register with `sprintengine.agent.join`, then claim work with `sprintengine.task.next` (implementation and planning tasks) or `sprintengine.gate.next` (quality gates) using `{role, id}`. Work what the claim returns; if it returns no claim, stop — Multicode re-engages the terminal when work is ready. Product and architect agents must read the referenced source file(s) at the project-root-relative paths listed in their claimed task, treat them as canonical incoming context, and update them in place rather than copying them.'
      : 'After initialization, agents continue through the managed MCP server: register with `sprintengine.agent.join`, then claim work with `sprintengine.task.next` (implementation and planning tasks) or `sprintengine.gate.next` (quality gates) using `{role, id}`. Work what the claim returns; if it returns no claim, stop — Multicode re-engages the terminal when work is ready. Product and architect agents must read the imported source file(s) in the Sprint Engine team folder when their own work is claimed, and should treat those files as incoming context.',
  ].filter((line): line is string => line !== null).join('\n\n')
}
