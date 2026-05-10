import { buildSpecialistSoulStartupPrompt, getSpecialistAction } from '../specialists/specialistActions'
import type { SpecialistActionId, WatchtowerReviewSectorId } from '../types/workspace'
import type { WatchtowerRun } from '../../../shared/switchboard'
import { getWatchtowerReviewSector, sectorLabel } from './watchtowerReview'

function relativePath(path: string, rootPath: string | null | undefined): string {
  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedRoot = rootPath?.replace(/\\/g, '/').replace(/\/+$/u, '')
  if (normalizedRoot && normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1)
  }
  return normalizedPath
}

function sectorInstructions(sectors: WatchtowerReviewSectorId[]): string[] {
  return sectors.map((sectorId) => {
    const sector = getWatchtowerReviewSector(sectorId)
    return `${sector.label}: ${sector.description}`
  })
}

export function buildWatchtowerStartupPrompt(input: {
  run: WatchtowerRun
  agent: {
    agentId: string
    specialistId: SpecialistActionId
    sectors: WatchtowerReviewSectorId[]
    outputDirectory: string
    reportPath: string
  }
  workspaceRoot: string
}): string {
  const specialist = getSpecialistAction(input.agent.specialistId)
  const reportPath = relativePath(input.agent.reportPath, input.workspaceRoot)

  return [
    buildSpecialistSoulStartupPrompt(specialist),
    '',
    '# Watchtower Review Assignment',
    '',
    `Run ID: ${input.run.runId}`,
    `Preset: ${input.run.preset}`,
    `Assigned sectors: ${input.agent.sectors.map(sectorLabel).join(', ')}`,
    `Workspace root: ${input.workspaceRoot}`,
    `Agent ID: ${input.agent.agentId}`,
    `Optional Markdown report: ${reportPath}`,
    '',
    'Work read-only unless the user explicitly asks for fixes. Do not edit product code, Switchboard task files, inbox files, Lock files, runner state, or Watchtower run metadata by hand.',
    'For each concrete finding, create a Switchboard inbox task directly with the Switchboard CLI. Do not write proposed-task JSON, JSONL, or output files for later ingestion.',
    'Before creating the first task, run `switchboard create --help` or `scripts/switchboard create --help` from the repository root to confirm the current schema.',
    'Use project-root-relative paths in descriptions and evidence. Include concrete files, symptoms, impact, and expected outcome.',
    '',
    '# Task Creation Contract',
    '',
    'Create one inbox task per finding. Prefer `switchboard` when it is on PATH; otherwise use `scripts/switchboard`.',
    '',
    '```bash',
    `switchboard create --workspace ${JSON.stringify(input.workspaceRoot)} --inbox --input-json '<json-payload>'`,
    '```',
    '',
    'Use this JSON payload shape:',
    '',
    '```json',
    JSON.stringify(
      {
        title: 'Short actionable task title',
        description: 'Concrete context, evidence, project-root-relative file paths, impact, and expected outcome.',
        priority: 1,
        labels: ['watchtower', 'security', 'backend'],
        source: {
          type: 'watchtower',
          externalId: `${input.run.runId}:${input.agent.agentId}:<random-uuid>`,
          externalKey: `${input.run.runId}:${input.agent.agentId}`,
          externalUrl: null,
        },
      },
      null,
      2
    ),
    '```',
    '',
    'The CLI generates the task UUID, validates the task shape, locks the inbox folder, and writes `.multi-code/switchboard/inbox/<uuid>.json` atomically.',
    'If a task creation command fails, read stderr, correct the payload, and retry. Do not hand-write Switchboard task files.',
    '',
    '# Sector Checklist',
    '',
    ...sectorInstructions(input.agent.sectors).map((line) => `- ${line}`),
  ].join('\n')
}
