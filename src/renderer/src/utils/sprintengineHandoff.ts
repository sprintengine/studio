type PlanFileSwarmHandoffPromptArgs = {
  teamSlug: string
  goal: string
  sourcePath: string
  sourceContent: string
  statePath: string
  useWorktreesForSwarms?: boolean
}

function quoteShellArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

export function buildCurrentContextSwarmHandoffPrompt(teamSlug: string): string {
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

export function buildPlanFileSwarmHandoffPrompt({
  teamSlug,
  goal,
  sourcePath,
  sourceContent,
  statePath,
  useWorktreesForSwarms = false,
}: PlanFileSwarmHandoffPromptArgs): string {
  const contentLines = sourceContent.trim().split(/\r?\n/).length

  return [
    'Create a Sprint Engine workspace from this saved future plan.',
    `Team name: \`${teamSlug}\``,
    `Goal: ${goal}`,
    `Source path: \`${sourcePath}\``,
    `Source snapshot: ${contentLines} markdown line${contentLines === 1 ? '' : 's'} selected by the user.`,
    `Target state path: \`${statePath}\``,
    '',
    'The renderer has only created local workspace metadata and this startup prompt. Canonical sprintengine files must be created by the Sprint Engine tool. Do not write `state.yaml`, `handover.md`, task state, or artifact state directly.',
    '',
    'First run the sprintengine handover command below. It tells the Sprint Engine tool to copy the selected markdown file into the team handover, so the run is tied to that file instead of only to the short objective. If the team already exists, or if handover reports a collision or failure, stop and report that to the user instead of overwriting anything.',
    '',
    '```shell',
    `sprintengine handover --name ${quoteShellArg(teamSlug)} --goal ${quoteShellArg(goal)} --use-worktrees ${useWorktreesForSwarms ? 'true' : 'false'} --handover ${quoteShellArg(sourcePath)}`,
    '```',
    '',
    'Only after `sprintengine handover` succeeds, initialize the Sprint Engine state at the target path:',
    '',
    '```shell',
    `sprintengine --state ${quoteShellArg(statePath)} init --goal ${quoteShellArg(goal)} --use-worktrees ${useWorktreesForSwarms ? 'true' : 'false'}`,
    '```',
    '',
    `After initialization, do not treat \`sprintengine init\` as task assignment. Agents should use the normal ready-task flow with \`sprintengine task next --role <role> --id <agent-id>\`. Product and architect agents must read \`${sourcePath}\` and the copied \`handover.md\` when their own task is claimed, and should treat that markdown file as incoming context.`,
  ].join('\n')
}
