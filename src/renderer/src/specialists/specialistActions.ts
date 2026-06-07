import type { MultiloopRole, SpecialistActionId } from '../types/workspace'

export type { MultiloopRole }

export type SpecialistIcon =
  | 'architecture'
  | 'code'
  | 'design'
  | 'design_review'
  | 'review'
  | 'spaghetti'
  | 'nuclear'
  | 'shield'
  | 'test'
  | 'infra'
  | 'product'
  | 'performance'
  | 'production_readiness'
  | 'cross_platform'
  | 'writing'

export type SpecialistAction = {
  id: SpecialistActionId
  label: string
  shortLabel: string
  description: string
  icon: SpecialistIcon
  soulRole: string
  shortcut?: string
}

export type MultiloopRoleDescriptor = {
  role: MultiloopRole
  label: string
  shortLabel: string
  icon: SpecialistIcon
}

export const MULTILOOP_ROLES: MultiloopRoleDescriptor[] = [
  { role: 'coordinator', label: 'Coordinator', shortLabel: 'Coordinator', icon: 'architecture' },
  { role: 'architect', label: 'Architect', shortLabel: 'Architect', icon: 'architecture' },
  { role: 'product', label: 'Product', shortLabel: 'Product', icon: 'product' },
  { role: 'developer', label: 'Developer', shortLabel: 'Developer', icon: 'code' },
  { role: 'frontend', label: 'Frontend', shortLabel: 'Frontend', icon: 'design' },
  { role: 'tester', label: 'Tester', shortLabel: 'Tester', icon: 'test' },
  { role: 'security', label: 'Security', shortLabel: 'Security', icon: 'shield' },
  { role: 'code_reviewer', label: 'Code Reviewer', shortLabel: 'Code Reviewer', icon: 'review' },
  { role: 'performance', label: 'Performance', shortLabel: 'Performance', icon: 'performance' },
  { role: 'cross_platform', label: 'Cross-platform', shortLabel: 'Compatibility', icon: 'cross_platform' },
]

export const SPECIALIST_ACTIONS: SpecialistAction[] = [
  {
    id: 'architect',
    label: 'Architecture Planning',
    shortLabel: 'Architect',
    description: 'Create implementation plans, compare approaches, and shape system design.',
    icon: 'architecture',
    soulRole: 'architect',
  },
  {
    id: 'product-strategist',
    label: 'Product Strategist',
    shortLabel: 'Product Strategist',
    description: 'Research competitors, evaluate product value, sharpen positioning, and challenge weak strategy.',
    icon: 'product',
    soulRole: 'product',
  },
  {
    id: 'developer',
    label: 'Backend Development',
    shortLabel: 'Developer',
    description: 'Build reliable backend, API, data, and server-side implementation work.',
    icon: 'code',
    soulRole: 'developer',
  },
  {
    id: 'devops-infra',
    label: 'DevOps & Infrastructure',
    shortLabel: 'DevOps',
    description: 'Review deployment, infrastructure, observability, reliability, and operations.',
    icon: 'infra',
    soulRole: 'devops',
  },
  {
    id: 'performance',
    label: 'Performance Engineer',
    shortLabel: 'Performance Engineer',
    description: 'Profile runtime behavior, memory use, CPU hot spots, bundle size, latency, and resource leaks.',
    icon: 'performance',
    soulRole: 'performance',
  },
  {
    id: 'production-readiness-review',
    label: 'Production Readiness Reviewer',
    shortLabel: 'Production Ready',
    description: 'Review release readiness across deployment, real integrations, data, observability, rollback, scale, and user setup.',
    icon: 'production_readiness',
    soulRole: 'production_readiness_reviewer',
  },
  {
    id: 'cross-platform',
    label: 'Cross-platform Specialist',
    shortLabel: 'Compatibility',
    description: 'Review operating system, browser, device, shell, filesystem, packaging, and runtime compatibility.',
    icon: 'cross_platform',
    soulRole: 'cross_platform',
  },
  {
    id: 'frontend-design-review',
    label: 'Frontend Designer',
    shortLabel: 'Frontend Designer',
    description: 'Design and implement polished frontend experiences, UI architecture, accessibility, and responsive behavior.',
    icon: 'design',
    soulRole: 'frontend',
  },
  {
    id: 'ui-ux-review',
    label: 'UI/UX Reviewer',
    shortLabel: 'UI/UX Reviewer',
    description: 'Review rendered UX/UI quality, brand alignment, responsive behavior, consistency across screens, and visual artifacts.',
    icon: 'design_review',
    soulRole: 'ui_ux_reviewer',
  },
  {
    id: 'blog-writer',
    label: 'Blog Writer',
    shortLabel: 'Blog Writer',
    description: 'Research, draft, edit, and package publish-ready blog posts with natural prose and image direction.',
    icon: 'writing',
    soulRole: 'blog_writer',
  },
  {
    id: 'qa-test',
    label: 'QA and Test Specialist',
    shortLabel: 'QA Specialist',
    description: 'Plan test strategy, cover edge cases, verify regressions, and assess release quality.',
    icon: 'test',
    soulRole: 'tester',
  },
  {
    id: 'security-review',
    label: 'Security Specialist',
    shortLabel: 'Security Specialist',
    description: 'Inspect vulnerabilities, trust boundaries, secrets, permissions, and risky defaults.',
    icon: 'shield',
    soulRole: 'security',
  },
  {
    id: 'code-review',
    label: 'Slop Cop',
    shortLabel: 'Slop Cop',
    description: 'Review implementation quality, generic AI-code patterns, fake affordances, design decay, and shallow abstractions.',
    icon: 'spaghetti',
    soulRole: 'code_reviewer',
  },
  {
    id: 'nuclear-review',
    label: 'Nuclear Reviewer',
    shortLabel: 'Nuclear Reviewer',
    description: 'Run a strict maintainability review using the Nuclear Review skill for structure, abstraction, large-file, and spaghetti-growth risks.',
    icon: 'nuclear',
    soulRole: 'nuclear_reviewer',
  },
  {
    id: 'spec-review',
    label: 'Spec Reviewer',
    shortLabel: 'Spec Reviewer',
    description: 'Review completed work against requirements, acceptance criteria, behavior, tests, and implementation evidence.',
    icon: 'review',
    soulRole: 'spec_reviewer',
  },
]

export function getSpecialistAction(id: SpecialistActionId | string | null | undefined): SpecialistAction {
  return SPECIALIST_ACTIONS.find((action) => action.id === id) ?? SPECIALIST_ACTIONS[0]
}

/**
 * Apply a user-defined display order to the specialist roster. IDs in `order`
 * are honored first (in their saved sequence); any specialist missing from the
 * order — e.g. a newly shipped role — is appended in canonical order so the
 * list never loses an entry. Unknown ids in `order` are ignored.
 */
export function orderSpecialistActions(order: readonly SpecialistActionId[]): SpecialistAction[] {
  const byId = new Map(SPECIALIST_ACTIONS.map((action) => [action.id, action]))
  const seen = new Set<SpecialistActionId>()
  const ordered: SpecialistAction[] = []
  for (const id of order) {
    const action = byId.get(id)
    if (action && !seen.has(id)) {
      ordered.push(action)
      seen.add(id)
    }
  }
  for (const action of SPECIALIST_ACTIONS) {
    if (!seen.has(action.id)) ordered.push(action)
  }
  return ordered
}

export function getMultiloopRole(role: MultiloopRole | string | null | undefined): MultiloopRoleDescriptor {
  return MULTILOOP_ROLES.find((descriptor) => descriptor.role === role) ?? MULTILOOP_ROLES[0]
}

export function buildMissingSpecialistSoul(action: SpecialistAction, message?: string): string {
  return [
    'Soul unavailable.',
    '',
    message ?? `The Souls registry could not render '${action.soulRole}'.`,
    'Run `souls validate` to inspect the registry, then restart this agent once the Soul renders cleanly.',
  ].join('\n')
}

export async function loadSpecialistSoul(specialistId: SpecialistActionId): Promise<string> {
  const action = getSpecialistAction(specialistId)

  try {
    const result = await window.api.readSpecialistSoul(action.id)
    return result.ok ? result.prompt : buildMissingSpecialistSoul(action, result.message)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return buildMissingSpecialistSoul(action, message)
  }
}

export function buildSpecialistSoulStartupPrompt(action: SpecialistAction): string {
  return [
    'Fetch your Soul from the Souls CLI before doing any role-specific work.',
    '',
    '```bash',
    `souls get ${action.soulRole}`,
    '```',
    '',
    'Treat the returned text as your role, judgment, and quality bar.',
    '',
    'After loading the Soul, do not begin role-specific work yet. Briefly acknowledge that you are ready in this role, then wait for the user to give you a task or question.',
    '',
    'If the `souls` command is unavailable, stop and report that the Souls CLI is unavailable instead of guessing the role prompt.',
  ].join('\n')
}

export type GuidedBriefSpecialistKind = 'strategist' | 'architect' | 'designer'

export type GuidedBriefSpecialistPromptInput =
  | {
      kind: 'strategist'
      ideaSeedPath?: string
      requirementsPath?: string
      marker?: string
    }
  | {
      kind: 'architect'
      ideaSeedPath?: string
      acceptedBriefSnapshotPath?: string | null
      architecturePlanPath?: string
      marker?: string
    }
  | {
      kind: 'designer'
      acceptedBriefSnapshotPath?: string
      acceptedArchitecturePlanPath?: string | null
      inspirationDirectoryPath?: string
      uiDirectionPath?: string
      mockupPath?: string
      marker?: string
    }

function guidedBriefInterviewInstructions(role: 'product strategist' | 'architect' | 'frontend designer'): string[] {
  return [
    `Conduct a guided ${role} interview before writing the artifact.`,
    'Ask exactly one question at a time.',
    'For each question, give 2-4 concrete multiple-choice options the user can pick from, with the recommended option first and clearly labeled "Recommended".',
    'Each option must include a short label and one sentence explaining the impact or tradeoff; include an "Other" or "Custom" option only when the decision genuinely needs it.',
    'After the options, briefly state why you recommend the first option and what materially changes if the user chooses a different option.',
    'Walk the design tree in dependency order: resolve upstream product, workflow, data, architecture, interface, UX, reliability, security, performance, and scope decisions before asking downstream implementation questions.',
    'If a question can be answered by inspecting the project files, docs, Knowledge Graph, or existing commands, inspect those sources before asking. If this is a new codebase and no source exists, say the assumption you are making.',
    'Continue interviewing until you and the user have a shared, explicit understanding of the artifact you are about to write.',
    'Do not ask bundled questionnaires. Do not skip unresolved branches by hiding them as assumptions.',
  ]
}

export function buildGuidedBriefSpecialistStartupPrompt(input: GuidedBriefSpecialistPromptInput): string {
  if (input.kind === 'strategist') {
    const marker = input.marker ?? 'BRIEF_READY'
    const ideaSeedPath = input.ideaSeedPath ?? 'product/idea-seed.md'
    const requirementsPath = input.requirementsPath ?? 'product/requirements.md'

    return [
      'Fetch your Soul from the Souls CLI before doing any product strategy work.',
      '',
      '```bash',
      'souls get product',
      '```',
      '',
      'Treat the returned text as your role, judgment, and quality bar.',
      '',
      `Read \`${ideaSeedPath}\` before asking follow-up questions.`,
      ...guidedBriefInterviewInstructions('product strategist'),
      `Write the accepted product brief to \`${requirementsPath}\`.`,
      `When and only when \`${requirementsPath}\` exists and is ready for user review, emit this exact marker on its own line:`,
      '',
      marker,
      '',
      'Do not create or mutate Sprint Engine state. This Guided brief flow hands off to Sprint Engine later.',
      'If the `souls` command is unavailable, stop and report that the Souls CLI is unavailable instead of guessing the role prompt.',
    ].join('\n')
  }

  if (input.kind === 'architect') {
    const marker = input.marker ?? 'ARCHITECTURE_PLAN_READY'
    const ideaSeedPath = input.ideaSeedPath ?? 'product/idea-seed.md'
    const architecturePlanPath = input.architecturePlanPath ?? 'architecture/plan.md'

    return [
      'Fetch your Soul from the Souls CLI before doing any architecture work.',
      '',
      '```bash',
      'souls get architect',
      '```',
      '',
      'Treat the returned text as your role, judgment, and quality bar.',
      '',
      `Read \`${ideaSeedPath}\` before asking follow-up questions.`,
      input.acceptedBriefSnapshotPath
        ? `Read the accepted product brief snapshot at \`${input.acceptedBriefSnapshotPath}\` before planning.`
        : 'No accepted product brief is available; use the idea seed as the product source of truth and make uncertainty explicit.',
      ...guidedBriefInterviewInstructions('architect'),
      `Write the accepted architecture plan to \`${architecturePlanPath}\`.`,
      'The architecture plan must cover goal, confirmed requirements, assumptions, open questions, architecture direction, real data/source-of-truth contracts, UI/API/service contracts where relevant, implementation tasks, verification strategy, risks, migration or rollback notes where relevant, and deferred work.',
      'The plan must not depend on template data, sample data, hardcoded demo entities, fake API responses, placeholder persistence, mocked services, or stubbed commands outside tests.',
      `When and only when \`${architecturePlanPath}\` exists and is ready for user review, emit this exact marker on its own line:`,
      '',
      marker,
      '',
      'Do not create or mutate Sprint Engine state. This Guided brief flow hands off to Sprint Engine later.',
      'If the `souls` command is unavailable, stop and report that the Souls CLI is unavailable instead of guessing the role prompt.',
    ].join('\n')
  }

  const marker = input.marker ?? 'MOCKUP_SET_READY'
  const inspirationDirectoryPath = input.inspirationDirectoryPath ?? '.guided-brief/inspiration'
  const uiDirectionPath = input.uiDirectionPath ?? 'product/ui-direction.md'
  const mockupPath = input.mockupPath ?? 'mockups/app.html'

  return [
    'Fetch your Soul from the Souls CLI before doing any frontend design work.',
    '',
    '```bash',
    'souls get frontend',
    '```',
    '',
    'Treat the returned text as your role, judgment, and quality bar.',
    '',
    input.acceptedArchitecturePlanPath
      ? `Read the accepted architecture plan snapshot at \`${input.acceptedArchitecturePlanPath}\` before designing.`
      : input.acceptedBriefSnapshotPath
        ? `Read the accepted product brief snapshot at \`${input.acceptedBriefSnapshotPath}\` before designing.`
        : 'No accepted product brief or architecture plan is available; read `product/idea-seed.md` and make uncertainty explicit.',
    `If the user has dropped inspiration files into \`${inspirationDirectoryPath}\`, read them through the existing CLI image-input path before drafting.`,
    ...guidedBriefInterviewInstructions('frontend designer'),
    `Write UX direction to \`${uiDirectionPath}\`.`,
    `Write the reviewable HTML mockup to \`${mockupPath}\`.`,
    `When and only when \`${uiDirectionPath}\` and the mockup HTML exist and are ready for user review, emit this exact marker on its own line:`,
    '',
    marker,
    '',
    'Do not introduce a new agent runtime protocol. Use only normal terminal stdout/stdin, prompt instructions, and this marker.',
    'Do not create or mutate Sprint Engine state. This Guided brief flow hands off to Sprint Engine later.',
    'If the `souls` command is unavailable, stop and report that the Souls CLI is unavailable instead of guessing the role prompt.',
  ].join('\n')
}

export function buildMissingMultiloopPrompt(descriptor: MultiloopRoleDescriptor, message?: string): string {
  return [
    'Multiloop role prompt unavailable.',
    '',
    message ?? `Could not load Multiloop prompt for ${descriptor.role}.`,
    'Restore multiloop_core/prompts.py or update the Multiloop role mapping, then restart this agent.',
  ].join('\n')
}

export async function loadMultiloopPrompt(role: MultiloopRole): Promise<string> {
  const descriptor = getMultiloopRole(role)

  try {
    const result = await window.api.readMultiloopPrompt(descriptor.role)
    return result.ok ? result.prompt : buildMissingMultiloopPrompt(descriptor, result.message)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return buildMissingMultiloopPrompt(descriptor, message)
  }
}
