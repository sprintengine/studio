import type { SpecialistActionId } from '../types/workspace'

export type SpecialistIcon =
  | 'architecture'
  | 'code'
  | 'design'
  | 'review'
  | 'shield'
  | 'test'
  | 'infra'
  | 'product'
  | 'performance'

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
    id: 'product-strategist',
    label: 'Product Strategist',
    shortLabel: 'Product Strategist',
    description: 'Research competitors, evaluate product value, sharpen positioning, and challenge weak strategy.',
    icon: 'product',
    promptFile: 'product-strategist-prompt.md',
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
    id: 'performance',
    label: 'Performance Engineer',
    shortLabel: 'Performance Engineer',
    description: 'Profile runtime behavior, memory use, CPU hot spots, bundle size, latency, and resource leaks.',
    icon: 'performance',
    promptFile: 'performance-engineer-prompt.md',
  },
  {
    id: 'frontend-design-review',
    label: 'Frontend Designer',
    shortLabel: 'Frontend Designer',
    description: 'Design and implement polished frontend experiences, UI architecture, accessibility, and responsive behavior.',
    icon: 'design',
    promptFile: 'frontend-design-promt.md',
  },
  {
    id: 'qa-test',
    label: 'QA and Test Specialist',
    shortLabel: 'QA Specialist',
    description: 'Plan test strategy, cover edge cases, verify regressions, and assess release quality.',
    icon: 'test',
    promptFile: 'qa-test-prompt.md',
  },
  {
    id: 'security-review',
    label: 'Security Specialist',
    shortLabel: 'Security Specialist',
    description: 'Inspect vulnerabilities, trust boundaries, secrets, permissions, and risky defaults.',
    icon: 'shield',
    promptFile: 'security-review-prompt.md',
  },
  {
    id: 'code-review',
    label: 'AI Slop Code Reviewer',
    shortLabel: 'AI Slop Reviewer',
    description: 'Review implementation quality, generic AI-code patterns, regressions, edge cases, and missing tests.',
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
