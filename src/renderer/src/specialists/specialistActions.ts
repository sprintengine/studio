import type { SpecialistActionId } from '../types/workspace'
import architectPrompt from '../../../../specialist-prompts/architect-prompt.txt?raw'
import codeReviewPrompt from '../../../../specialist-prompts/code-reviewer-pre-prompt.txt?raw'
import developerPrompt from '../../../../specialist-prompts/developer-prompt.txt?raw'
import devopsInfraPrompt from '../../../../specialist-prompts/devops-infra-prompt.txt?raw'
import frontendDesignPrompt from '../../../../specialist-prompts/frontend-design-promt.txt?raw'
import qaTestPrompt from '../../../../specialist-prompts/qa-test-prompt.txt?raw'
import securityReviewPrompt from '../../../../specialist-prompts/security-review-prompt.txt?raw'

export type SpecialistIcon = 'architecture' | 'code' | 'design' | 'review' | 'shield' | 'test' | 'infra'

export type SpecialistAction = {
  id: SpecialistActionId
  label: string
  shortLabel: string
  description: string
  icon: SpecialistIcon
  buildPrompt: () => string
}

export const SPECIALIST_ACTIONS: SpecialistAction[] = [
  {
    id: 'architect',
    label: 'Architecture Planning',
    shortLabel: 'Architect',
    description: 'Create implementation plans, compare approaches, and shape system design.',
    icon: 'architecture',
    buildPrompt: () => architectPrompt,
  },
  {
    id: 'developer',
    label: 'Backend Development',
    shortLabel: 'Developer',
    description: 'Build reliable backend, API, data, and server-side implementation work.',
    icon: 'code',
    buildPrompt: () => developerPrompt,
  },
  {
    id: 'devops-infra',
    label: 'DevOps & Infrastructure',
    shortLabel: 'DevOps',
    description: 'Review deployment, infrastructure, observability, reliability, and operations.',
    icon: 'infra',
    buildPrompt: () => devopsInfraPrompt,
  },
  {
    id: 'frontend-design-review',
    label: 'Frontend Design Review',
    shortLabel: 'Design Review',
    description: 'Assess UI polish, frontend architecture, accessibility, and responsive behavior.',
    icon: 'design',
    buildPrompt: () => frontendDesignPrompt,
  },
  {
    id: 'qa-test',
    label: 'QA & Test Review',
    shortLabel: 'QA Test',
    description: 'Plan and review test strategy, edge cases, regressions, and release quality.',
    icon: 'test',
    buildPrompt: () => qaTestPrompt,
  },
  {
    id: 'security-review',
    label: 'Security Review',
    shortLabel: 'Security Review',
    description: 'Look for vulnerabilities, trust boundaries, secrets, and risky defaults.',
    icon: 'shield',
    buildPrompt: () => securityReviewPrompt,
  },
  {
    id: 'code-review',
    label: 'Code Review',
    shortLabel: 'Code Review',
    description: 'Review implementation quality, regressions, edge cases, and missing tests.',
    icon: 'review',
    buildPrompt: () => codeReviewPrompt,
  },
]

export function getSpecialistAction(id: SpecialistActionId | string | null | undefined): SpecialistAction {
  return SPECIALIST_ACTIONS.find((action) => action.id === id) ?? SPECIALIST_ACTIONS[0]
}
