type PlanFileSwarmHandoffPromptArgs = {
  teamSlug: string
  goal: string
  sourcePath: string
  sourceContent: string
  statePath: string
  useWorktreesForSwarms?: boolean
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function pickHeredocDelimiter(content: string): string {
  const usedLines = new Set(content.split(/\r?\n/).map((line) => line.trim()))
  let delimiter = 'SWARM_HANDOVER'
  let suffix = 2

  while (usedLines.has(delimiter)) {
    delimiter = `SWARM_HANDOVER_${suffix}`
    suffix += 1
  }

  return delimiter
}

export function buildCurrentContextSwarmHandoffPrompt(teamSlug: string): string {
  return [
    'Convert your current plan and context into a swarm handoff.',
    `Team name: \`${teamSlug}\``,
    'Do not run `swarm init`. Do not create task cards. Do not start implementation.',
    'First derive a concise one-sentence swarm goal from your current plan.',
    'Then write a complete markdown handover and pass it to the swarm tool as stdin. The Python tool must create `handover.md`; do not write that file directly.',
    'Use this command shape:',
    '```bash',
    `swarm handover --name ${JSON.stringify(teamSlug)} --goal "<derived one-sentence goal>" --handover-stdin <<'SWARM_HANDOVER'`,
    '# Handover',
    '',
    '<your complete markdown handover>',
    'SWARM_HANDOVER',
    '```',
    'If the team already exists, stop and report that to the user instead of overwriting it.',
    'The handover must include confirmed decisions, open questions, implementation approach, likely files to touch, task breakdown suggestions, risks, and validation notes.',
    `When done, tell the user to open or create a swarm workspace and select team \`${teamSlug}\`.`,
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
  const delimiter = pickHeredocDelimiter(sourceContent)

  return [
    'Create a swarm workspace from this saved future plan.',
    `Team name: \`${teamSlug}\``,
    `Goal: ${goal}`,
    `Source path: \`${sourcePath}\``,
    `Target state path: \`${statePath}\``,
    '',
    'The renderer has only created local workspace metadata and this startup prompt. Canonical swarm files must be created by the swarm tool. Do not write `state.yaml`, `handover.md`, task state, or artifact state directly.',
    '',
    'First run the swarm handover command below, passing the plan markdown snapshot as stdin. If the team already exists, or if handover reports a collision or failure, stop and report that to the user instead of overwriting anything.',
    '',
    '```bash',
    `swarm handover --name ${quoteShellArg(teamSlug)} --goal ${quoteShellArg(goal)} --use-worktrees ${useWorktreesForSwarms ? 'true' : 'false'} --handover-stdin <<'${delimiter}'`,
    `# Handover From ${sourcePath}`,
    '',
    sourceContent,
    delimiter,
    '```',
    '',
    'Only after `swarm handover` succeeds, initialize the swarm state at the target path:',
    '',
    '```bash',
    `swarm --state ${quoteShellArg(statePath)} init --goal ${quoteShellArg(goal)} --use-worktrees ${useWorktreesForSwarms ? 'true' : 'false'}`,
    '```',
    '',
    'After initialization, follow the prompt returned by the swarm tool. New swarms begin with product intake; architect planning starts after the product artifact is approved.',
  ].join('\n')
}
