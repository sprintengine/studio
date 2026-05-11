import { buildSpecialistSoulStartupPrompt, getSpecialistAction } from '../specialists/specialistActions'
import type { SwitchboardTaskRecord, WatchtowerRun } from '../../../shared/switchboard'

function taskLine(record: SwitchboardTaskRecord): string {
  return `- ${record.task.id} (${record.task.identifier}): ${record.task.title}`
}

export function buildWatchtowerTriagePrompt(input: {
  run: WatchtowerRun
  workspaceRoot: string
  tasks: SwitchboardTaskRecord[]
  scopeLabel: string
}): string {
  const architect = getSpecialistAction('architect')
  const taskIds = input.tasks.map((record) => record.task.id)

  return [
    buildSpecialistSoulStartupPrompt(architect),
    '',
    '# Watchtower Inbox Triage Assignment',
    '',
    `Run ID: ${input.run.runId}`,
    'Preset: inbox_triage',
    `Workspace root: ${input.workspaceRoot}`,
    `Scope: ${input.scopeLabel}`,
    '',
    'You are triaging existing Switchboard inbox items. Read each scoped item, compare it with the rest of the inbox and board, inspect relevant repo context, and leave exactly one triage comment on each scoped item.',
    'After commenting on one scoped item, continue to the next scoped item. When every scoped item has a triage comment, stop.',
    '',
    '# Scoped Items',
    '',
    ...input.tasks.map(taskLine),
    '',
    '# Read Contract',
    '',
    'Use project-root-relative paths in all analysis. Prefer the local Switchboard CLI from the repository root:',
    '',
    '```bash',
    `scripts/switchboard read-all --workspace ${JSON.stringify(input.workspaceRoot)}`,
    'scripts/switchboard show --workspace <repo> <task-id>',
    '```',
    '',
    'Check duplicate candidates across inbox tasks and board tasks. Include likely duplicates only when the overlap is concrete enough to help a human decide.',
    '',
    '# Mutation Contract',
    '',
    'You may only add triage comments through the Switchboard CLI. Do not promote, cancel, move, claim, publish, edit, or requeue tasks. Do not edit task JSON, inbox files, Lock files, runner state, or Watchtower run metadata by hand.',
    'For each scoped item, write the comment with:',
    '',
    '```bash',
    `scripts/switchboard comment --workspace ${JSON.stringify(input.workspaceRoot)} <task-id> --kind triage --author Architect --author-type agent --author-id watchtower-architect --body '<comment-body>'`,
    '```',
    '',
    '# Triage Comment Format',
    '',
    'Use this exact heading and fields for every triage comment:',
    '',
    '```text',
    'Architect triage',
    '',
    'Recommendation: Promote | Needs clarification | Duplicate | Defer | Reject',
    'Importance: Critical | High | Medium | Low',
    '',
    'Why it matters:',
    '...',
    '',
    'Impact if not fixed:',
    '...',
    '',
    'Implementation plan:',
    '1. ...',
    '2. ...',
    '',
    'Likely touched areas:',
    '- ...',
    '',
    'Duplicate check:',
    'None found | Possible duplicate of <identifier/title> because ...',
    '',
    'Verification:',
    '- ...',
    '```',
    '',
    '# Completion',
    '',
    `Scoped task ids: ${taskIds.join(', ') || '(none)'}`,
    'If there are no scoped task ids, add no comments and report that there was nothing to triage.',
  ].join('\n')
}
