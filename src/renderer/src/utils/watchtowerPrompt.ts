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

function brandContextInstructions(sectors: WatchtowerReviewSectorId[]): string[] {
  if (!sectors.includes('brand_alignment')) return []

  return [
    '',
    '# Brand Alignment Context',
    '',
    'Before creating brand-alignment findings, inspect the repo-local knowledge graph for brand guidance. Start with `knowledge/brand/BRAND.md`, then check `knowledge/brand/panel-design-system.md`, `knowledge/brand/workspace-themes.md`, and `knowledge/multicode/watchtower.md` when present.',
    'If no brand guideline exists in the knowledge graph for this workspace, infer the current brand from implemented panels and adjacent UI surfaces instead of inventing a new direction.',
    'For UI and brand review, sweep the full application surface you can reach from the codebase: panels, modal/dialog flows, forms, empty/loading/error/disabled states, navigation, command surfaces, copy tone, color usage, spacing, typography, icons, and responsive behavior.',
    'Findings must cite the violated brand guideline path when one exists. When using inferred brand instead, say which existing panels or UI files established the pattern.',
  ]
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
    ...brandContextInstructions(input.agent.sectors),
  ].join('\n')
}
