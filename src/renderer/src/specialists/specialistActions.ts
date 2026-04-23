import type { SpecialistActionId } from '../types/workspace'

export type SpecialistIcon = 'architecture' | 'code' | 'design' | 'review' | 'shield' | 'test' | 'infra'

export type SpecialistAction = {
  id: SpecialistActionId
  label: string
  shortLabel: string
  description: string
  icon: SpecialistIcon
  promptFile: string
}

export const SPECIALIST_ACTIONS: SpecialistAction[] = [
  {
    id: 'architect',
    label: 'Architecture Planning',
    shortLabel: 'Architect',
    description: 'Create implementation plans, compare approaches, and shape system design.',
    icon: 'architecture',
    promptFile: 'architect-prompt.md',
  },
  {
    id: 'developer',
    label: 'Backend Development',
    shortLabel: 'Developer',
    description: 'Build reliable backend, API, data, and server-side implementation work.',
    icon: 'code',
    promptFile: 'developer-prompt.md',
  },
  {
    id: 'devops-infra',
    label: 'DevOps & Infrastructure',
    shortLabel: 'DevOps',
    description: 'Review deployment, infrastructure, observability, reliability, and operations.',
    icon: 'infra',
    promptFile: 'devops-infra-prompt.md',
  },
  {
    id: 'frontend-design-review',
    label: 'Frontend Design Review',
    shortLabel: 'Design Review',
    description: 'Assess UI polish, frontend architecture, accessibility, and responsive behavior.',
    icon: 'design',
    promptFile: 'frontend-design-promt.md',
  },
  {
    id: 'qa-test',
    label: 'QA & Test Review',
    shortLabel: 'QA Test',
    description: 'Plan and review test strategy, edge cases, regressions, and release quality.',
    icon: 'test',
    promptFile: 'qa-test-prompt.md',
  },
  {
    id: 'security-review',
    label: 'Security Review',
    shortLabel: 'Security Review',
    description: 'Look for vulnerabilities, trust boundaries, secrets, and risky defaults.',
    icon: 'shield',
    promptFile: 'security-review-prompt.md',
  },
  {
    id: 'code-review',
    label: 'Code Review',
    shortLabel: 'Code Review',
    description: 'Review implementation quality, regressions, edge cases, and missing tests.',
    icon: 'review',
    promptFile: 'code-reviewer-pre-prompt.md',
  },
]

export function getSpecialistAction(id: SpecialistActionId | string | null | undefined): SpecialistAction {
  return SPECIALIST_ACTIONS.find((action) => action.id === id) ?? SPECIALIST_ACTIONS[0]
}

export function buildMissingSpecialistPrompt(action: SpecialistAction, message?: string): string {
  return [
    'Specialist prompt file missing.',
    '',
    message ?? `Could not load specialist-prompts/${action.promptFile}.`,
    'Restore the prompt file or update the specialist prompt mapping, then restart this agent.',
  ].join('\n')
}

export async function loadSpecialistPrompt(specialistId: SpecialistActionId): Promise<string> {
  const action = getSpecialistAction(specialistId)

  try {
    const result = await window.api.readSpecialistPrompt(action.id)
    return result.ok ? result.prompt : buildMissingSpecialistPrompt(action, result.message)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return buildMissingSpecialistPrompt(action, message)
  }
}
