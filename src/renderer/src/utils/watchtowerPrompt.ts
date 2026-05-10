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
  const outputDirectory = relativePath(input.agent.outputDirectory, input.workspaceRoot)
  const reportPath = relativePath(input.agent.reportPath, input.workspaceRoot)

  return [
    buildSpecialistSoulStartupPrompt(specialist),
    '',
    '# Watchtower Review Assignment',
    '',
    `Run ID: ${input.run.runId}`,
    `Preset: ${input.run.preset}`,
    `Assigned sectors: ${input.agent.sectors.map(sectorLabel).join(', ')}`,
    `Output directory: ${outputDirectory}`,
    `Optional Markdown report: ${reportPath}`,
    '',
    'Work read-only unless the user explicitly asks for fixes. Do not edit product code, Switchboard task files, inbox files, Lock files, runner state, or Watchtower run metadata.',
    'Write proposed tasks as JSON or JSONL files in your assigned output directory. The task JSON output is the source of truth for ingestion; the Markdown report is optional context only.',
    'Use project-root-relative paths in evidence. Include concrete files, symptoms, impact, and expected outcome.',
    'Do not invent or set source.externalId. Watchtower derives source identity during ingestion. You may include localId only when it is stable within this run.',
    '',
    '# Proposed Task JSON Contract',
    '',
    'Each proposed task must be one JSON object with this shape:',
    '',
    '```json',
    JSON.stringify(
      {
        title: 'Short actionable task title',
        description: 'Concrete context, evidence, and expected outcome.',
        priority: 1,
        labels: ['security', 'backend'],
        evidence: {
          files: ['src/main/example.ts'],
          summary: 'Why this task exists.',
        },
        localId: 'optional-agent-local-id',
      },
      null,
      2
    ),
    '```',
    '',
    'For multiple proposals, prefer `proposed-tasks.jsonl` with one object per line. Individual `proposed-task-<localId>.json` files are also accepted.',
    '',
    '# Sector Checklist',
    '',
    ...sectorInstructions(input.agent.sectors).map((line) => `- ${line}`),
  ].join('\n')
}
