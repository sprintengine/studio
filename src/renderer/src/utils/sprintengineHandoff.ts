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
}

function quoteShellArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
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
        return 'Source bundle type: HTML mockup. Sprint Engine init should route the source to product and architect review as context. The reviewers should use it to clarify intent with the user, then create product requirements and an implementation plan before execution.'
      }
      if (kind === 'product_plan') {
        return 'Source bundle type: product plan. Sprint Engine init should seed product-requirements.md for review. A rostered product strategist should review and update it instead of recreating the same product plan.'
      }
      if (kind === 'architect_plan') {
        return 'Source bundle type: implementation plan. Sprint Engine init should seed plan.md for architect review. The architect should review it against the current codebase, update stale details, mark it ready for user approval, then create task cards.'
      }
      if (kind === 'design_notes') {
        return 'Source bundle type: design notes. Sprint Engine init should route the source to product and architect review as design context, and relevant UI tasks should reference it in implementation notes.'
      }
      if (kind === 'generic_context' || kind === 'unknown') {
        return 'Source bundle type: context. Sprint Engine init should route the source to product and architect review as incoming context. Reviewers should clarify intent with the user before turning it into requirements, an implementation plan, and task cards.'
      }
    }
    if (kinds.includes('product_plan') || kinds.includes('architect_plan')) {
      return 'Source bundle type: mixed sources. Sprint Engine init should seed canonical files from product and implementation plan sources when present, preserve source edits on rerun, and route review work to rostered specialists before execution planning continues.'
    }
    return 'Source bundle type: mixed context sources. Sprint Engine init should route the sources to product and architect review as mockup, design, and context input. Reviewers should clarify intent with the user before turning it into requirements, an implementation plan, and task cards.'
  }

  if (sourcePlanKind === 'product_plan') {
    return 'Source plan type: product plan. Sprint Engine init should seed product-requirements.md for review. A rostered product strategist should review and update it instead of recreating the same product plan.'
  }
  if (sourcePlanKind === 'architect_plan') {
    return 'Source plan type: implementation plan. Sprint Engine init should seed plan.md for architect review. The architect should review it against the current codebase, update stale details, then create task cards.'
  }
  return 'Source plan type: generic handoff. Sprint Engine should use the normal product intake and architect planning gates.'
}

export function buildCurrentContextSprintEngineHandoffPrompt(teamSlug: string): string {
  return [
    'Convert your current plan and context into a sprintengine handoff.',
    `Team name: \`${teamSlug}\``,
    'Do not run `sprintengine init`. Do not create task cards. Do not start implementation.',
    'First derive a concise one-sentence sprintengine goal from your current plan.',
    'Then write a complete markdown handover and pass it to the Sprint Engine tool as stdin. The Python tool must create `handover.md`; do not write that file directly.',
    'Use this command shape:',
    '```bash',
    `sprintengine handover --name ${JSON.stringify(teamSlug)} --goal "<derived one-sentence goal>" --handover-stdin <<'SPRINTENGINE_HANDOVER'`,
    '# Handover',
    '',
    '<your complete markdown handover>',
    'SPRINTENGINE_HANDOVER',
    '```',
    'If the team already exists, stop and report that to the user instead of overwriting it.',
    'The handover must include confirmed decisions, open questions, implementation approach, likely files to touch, task breakdown suggestions, risks, and validation notes.',
    `When done, tell the user to open or create a Sprint Engine workspace and select team \`${teamSlug}\`.`,
  ].join('\n\n')
}

export function buildPlanFileSprintEngineHandoffPrompt({
  teamSlug,
  goal,
  sourcePath,
  sourceContent,
  sourcePlanKind = 'unknown',
  sourceBundle = [],
  statePath,
  rosterArgs = [],
}: PlanFileSprintEngineHandoffPromptArgs): string {
  const hasExplicitSourceBundle = sourceBundle.length > 0
  const bundle = hasExplicitSourceBundle
    ? sourceBundle
    : [{ kind: sourcePlanKind, sourcePath, sourceContent }]
  const contentLines = bundle.reduce((sum, item) => sum + item.sourceContent.trim().split(/\r?\n/).length, 0)
  const rosterFlags = rosterArgs.length > 0
    ? ` ${rosterArgs.map((arg) => `--agent ${quoteShellArg(arg)}`).join(' ')}`
    : ''
  const sourceKindFlag = ` --source-plan-kind ${quoteShellArg(sourcePlanKind)}`
  const sourceBundleFlags = hasExplicitSourceBundle
    ? ` ${bundle.map((item) => `--source ${quoteShellArg(`${item.kind}:${item.sourcePath}`)}`).join(' ')}`
    : ''
  const handoverCommand = hasExplicitSourceBundle
    ? `sprintengine handover --name ${quoteShellArg(teamSlug)} --goal ${quoteShellArg(goal)}${sourceBundleFlags}${rosterFlags}`
    : `sprintengine handover --name ${quoteShellArg(teamSlug)} --goal ${quoteShellArg(goal)} --handover ${quoteShellArg(sourcePath)}${sourceKindFlag}${rosterFlags}`
  const sourceSummary = hasExplicitSourceBundle
    ? bundle.map((item) => `- ${item.kind}: \`${item.sourcePath}\``).join('\n')
    : `Source path: \`${sourcePath}\``

  return [
    hasExplicitSourceBundle
      ? 'Create a Sprint Engine workspace from this saved source bundle.'
      : 'Create a Sprint Engine workspace from this saved future plan.',
    `Team name: \`${teamSlug}\``,
    `Goal: ${goal}`,
    sourceSummary,
    `Source snapshot: ${contentLines} total text line${contentLines === 1 ? '' : 's'} selected by the user.`,
    `Target state path: \`${statePath}\``,
    '',
    'The renderer has only created local workspace metadata and this startup prompt. Canonical sprintengine files must be created by the Sprint Engine tool. Do not write run-store files, `handover.md`, task state, or artifact state directly.',
    '',
    hasExplicitSourceBundle
      ? 'First run the sprintengine handover command below. It tells the Sprint Engine tool to copy the selected source file(s) into the team sources directory, so the run is tied to those files instead of only to the short objective. If the team already exists, or if handover reports a collision or failure, stop and report that to the user instead of overwriting anything.'
      : 'First run the sprintengine handover command below. It tells the Sprint Engine tool to copy the selected markdown file into the team handover, so the run is tied to that file instead of only to the short objective. If the team already exists, or if handover reports a collision or failure, stop and report that to the user instead of overwriting anything.',
    '',
    '```shell',
    handoverCommand,
    '```',
    '',
    'Only after `sprintengine handover` succeeds, initialize the Sprint Engine state at the target path:',
    '',
    '```shell',
    `sprintengine --state ${quoteShellArg(statePath)} init --goal ${quoteShellArg(goal)}${rosterFlags}`,
    '```',
    '',
    rosterArgs.length > 0
      ? `Roster constraint: the architect must create tasks only for these selected Sprint Engine agents: ${rosterArgs.join(', ')}. If a specialist role is absent from this roster, do not create tasks for that role.`
      : null,
    sourceTypeGuidance(hasExplicitSourceBundle, bundle, sourcePlanKind),
    `After initialization, do not treat \`sprintengine init\` as task assignment. Agents should use the join-watch flow with \`sprintengine join --role <role> --id <agent-id> --watch\`; the CLI will direct them to claim implementation tasks, quality gates, or needs_input triage when work is ready. Product and architect agents must read the imported source file(s) in the Sprint Engine team folder when their own work is claimed, and should treat those files as incoming context.`,
  ].join('\n')
}
