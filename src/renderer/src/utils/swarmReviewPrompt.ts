import { buildSpecialistSoulStartupPrompt, getSpecialistAction } from '../specialists/specialistActions'
import type { SwarmReviewAgent, SwarmReviewWorkspaceState } from '../types/workspace'
import { getSwarmReviewSector, sectorLabel } from './swarmReview'

function relativePath(path: string, rootPath: string | null | undefined): string {
  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedRoot = rootPath?.replace(/\\/g, '/').replace(/\/+$/u, '')
  if (normalizedRoot && normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1)
  }
  return normalizedPath
}

export function buildSwarmReviewReportTemplate(input: {
  agent: SwarmReviewAgent
  state: SwarmReviewWorkspaceState
  workspaceRoot?: string | null
}): string {
  const specialist = getSpecialistAction(input.agent.specialistId)
  const sectors = input.agent.sectors.map(sectorLabel).join(', ')
  return [
    `# ${specialist.shortLabel} Review`,
    '',
    `Run: ${input.state.name}`,
    `Sectors: ${sectors}`,
    '',
    '## Scope Reviewed',
    '',
    '## Findings',
    '',
    '| Severity | Area | File | Finding | Recommendation |',
    '| --- | --- | --- | --- | --- |',
    '',
    '## Evidence',
    '',
    '## False Positives / Non-Issues',
    '',
    '## Recommended Follow-Up',
    '',
  ].join('\n')
}

function sectorInstructions(agent: SwarmReviewAgent): string[] {
  return agent.sectors.flatMap((sectorId) => {
    const sector = getSwarmReviewSector(sectorId)
    const base = [`${sector.label}: ${sector.description}`]
    if (sectorId === 'security') {
      base.push(
        'For security, map renderer, preload, main process, terminal shell, filesystem, auth, mobile bridge, Sprint Engine tools, external API, and local storage trust boundaries.',
        'Separate exploitable vulnerabilities from hardening recommendations. Inspect command execution, path handling, direct state writes, token storage, logging, and prompt/tool abuse risks.'
      )
    }
    if (sectorId === 'ai_slop') {
      base.push(
        'For AI slop, flag plausible but unused code, fake UI affordances, unsupported copy, hallucinated APIs, one-call abstractions, broad catch-all fallbacks, generic naming, and untested boilerplate.'
      )
    }
    return base
  })
}

export function buildSwarmReviewStartupPrompt(input: {
  agent: SwarmReviewAgent
  state: SwarmReviewWorkspaceState
  workspaceRoot?: string | null
}): string {
  const specialist = getSpecialistAction(input.agent.specialistId)
  const reportPath = relativePath(input.agent.reportPath, input.workspaceRoot)
  const outputDirectory = relativePath(input.state.outputDirectory, input.workspaceRoot)
  const reportTemplate = buildSwarmReviewReportTemplate(input)

  return [
    buildSpecialistSoulStartupPrompt(specialist),
    '',
    '# Swarm Review Assignment',
    '',
    `Swarm review: ${input.state.name}`,
    `Objective: ${input.state.objective}`,
    `Assigned sectors: ${input.agent.sectors.map(sectorLabel).join(', ')}`,
    `Output directory: ${outputDirectory}`,
    `Write your final report to: ${reportPath}`,
    '',
    'Work read-only unless the user explicitly asks for fixes. Do not edit product code, Sprint Engine state, generated task state, or report files other than your assigned report.',
    'Use project-root-relative paths in findings. Include concrete evidence, severity, affected files, and reproduction or verification steps where possible.',
    'Review the full codebase proportionally. Start with project structure, package scripts, security-sensitive files, workspace state, terminal spawning, IPC, filesystem operations, and UI surfaces.',
    'Mark uncertainty explicitly. Do not inflate weak issues. Avoid duplicate findings owned by another sector; cross-reference them instead.',
    '',
    '# Sector Checklist',
    '',
    ...sectorInstructions(input.agent).map((line) => `- ${line}`),
    '',
    '# Required Report Template',
    '',
    'Replace the placeholder sections in this Markdown template and save it to the assigned report path:',
    '',
    '```md',
    reportTemplate.trimEnd(),
    '```',
  ].join('\n')
}
