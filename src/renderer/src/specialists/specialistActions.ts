import type { DesignSystemSeedSource, MultiloopRole, SpecialistActionId } from '../types/workspace'
import { DESIGN_SYSTEM_ATTACHED_PROMPT_LINE } from '../../../shared/design-system/attach'
import { DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME } from '../../../shared/design-system/bundle-scaffold'
import { pathJoin } from '../utils/paths'

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
  // A specialist's id is its registry role id, so `soulRole === id` always. The
  // field is kept (rather than folded into `id`) so call sites reading a role
  // for `souls get <role>` stay explicit about intent.
  soulRole: string
  shortcut?: string
}

// Reserved engine-defaults key for the General agent. General is not special-
// cased: its CLI + model persist through the same `specialistCliDefaults` /
// `specialistModelDefaults` maps as every specialist, keyed by this sentinel.
// The double-underscore guarantees it never collides with a real specialist id,
// and it is never added to the specialist roster or `specialistOrder`.
export const GENERAL_AGENT_ENGINE_KEY = '__general__' as SpecialistActionId

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
  { role: 'performance', label: 'Performance', shortLabel: 'Performance', icon: 'performance' },
  { role: 'cross_platform', label: 'Cross-platform', shortLabel: 'Compatibility', icon: 'cross_platform' },
]

// Curated display order for the specialist roster, keyed by registry role id.
// Specialists no longer ship as a hardcoded catalog — the roster is sourced from
// the role registry (see specialistPacks.ts), which groups roles by source layer
// and sorts alphabetically. This list restores a deliberate default ordering for
// the known first-party roles; any role not listed here (a workspace/user/plugin
// specialist) is appended after them. It is display-only: it never adds or drops
// a specialist, only sequences the ones the registry actually surfaces.
export const SPECIALIST_DISPLAY_ORDER: readonly string[] = [
  'architect',
  'product',
  'developer',
  'devops',
  'performance',
  'production_readiness_reviewer',
  'cross_platform',
  'frontend',
  'ui_ux_reviewer',
  'blog_writer',
  'tester',
  'security',
]

// Synthesize a specialist action for a registry role id. The id is the registry
// role id, so its soul is rendered by `souls get <id>`; label/icon fall back to
// the id and a neutral glyph. Callers that have registry metadata (the pickers,
// via specialistPacks.ts) prefer that richer action; this is the pure-id
// fallback for a selected id no longer present in the registry.
export function synthesizeSpecialistAction(id: string): SpecialistAction {
  return {
    id,
    label: id,
    shortLabel: id,
    description: '',
    icon: 'code',
    soulRole: id,
  }
}

// Resolve a specialist id to an action shape. Every id is a registry role id, so
// its soul renders via `souls get <id>`; this synthesizes the shape from the id
// alone. Rich display metadata (manifest label/icon) comes from the
// registry-sourced pack list, not from here. Empty input yields a neutral empty
// placeholder rather than throwing, so a missing selection degrades safely.
export function getSpecialistAction(id: SpecialistActionId | null | undefined): SpecialistAction {
  return synthesizeSpecialistAction(id ?? '')
}

/**
 * Sequence a specialist roster for display. IDs in `order` (a user-defined
 * order) are honored first in their saved sequence, then the curated
 * `SPECIALIST_DISPLAY_ORDER` for known first-party roles, then any remaining
 * specialists in `actions` order (e.g. a workspace/user/plugin role not in
 * either list). Every action in `actions` appears exactly once; unknown ids in
 * the order lists are ignored. Never adds or drops an entry.
 */
export function orderSpecialistActions(
  order: readonly SpecialistActionId[],
  actions: readonly SpecialistAction[],
): SpecialistAction[] {
  const byId = new Map(actions.map((action) => [action.id, action]))
  const seen = new Set<SpecialistActionId>()
  const ordered: SpecialistAction[] = []
  for (const id of [...order, ...SPECIALIST_DISPLAY_ORDER]) {
    const action = byId.get(id)
    if (action && !seen.has(id)) {
      ordered.push(action)
      seen.add(id)
    }
  }
  for (const action of actions) {
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

// Autonomous-run variant of the soul startup prompt. Unlike the interactive
// build above — which fetches the Soul then waits for a human to hand over a
// task — an automation agent has no human in the loop, so it must fetch the
// Soul and then immediately carry out the directive in that role. The directive
// is the main-process-composed automation prompt (autonomy policy + run-status
// signal instructions), kept verbatim below so its reporting contract stands.
export function buildSpecialistDirectiveStartupPrompt(action: SpecialistAction, directive: string): string {
  return [
    'Fetch your Soul from the Souls CLI before doing any role-specific work.',
    '',
    '```bash',
    `souls get ${action.soulRole}`,
    '```',
    '',
    'Treat the returned text as your role, judgment, and quality bar.',
    '',
    'After loading the Soul, carry out the directive below in this role. Do not wait for further input — this is an autonomous run.',
    '',
    'If the `souls` command is unavailable, do not guess the role prompt: treat the run as failed and report that the Souls CLI is unavailable via the run-status reporting described in the directive.',
    '',
    '---',
    '',
    directive.trim(),
  ].join('\n')
}

/**
 * Launch-time injection predicate for the attached-design-system prompt line:
 * the line is emitted when and only when `design-system/` exists in the
 * agent's execution root. Resolved once per launch, mirroring how the
 * knowledge suffix resolves its root (TerminalView appends the returned line
 * to the launch prompt; the guided designer spawn passes the boolean through
 * its session input). KG-independent by design.
 */
export async function resolveDesignSystemAttachedPromptLine(
  executionRoot: string | null | undefined,
  pathExists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  const root = executionRoot?.trim()
  if (!root) return null
  const attached = await pathExists(pathJoin(root, DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME)).catch(() => false)
  return attached ? DESIGN_SYSTEM_ATTACHED_PROMPT_LINE : null
}

export type GuidedBriefSpecialistKind = 'strategist' | 'architect' | 'designer'

// How the interview reaches the user: 'terminal-markers' mirrors questions as
// GUIDED_QUESTION stdout blocks the app scrapes from the PTY (legacy path);
// 'ask-user-question' uses the CLI's AskUserQuestion tool, which conversation
// sessions intercept and render as native question cards.
export type GuidedBriefInterviewProtocol = 'terminal-markers' | 'ask-user-question'

// Activation line for the curated frontend-design skill. Claude Code
// auto-discovers .claude/skills/ but names-in-prompt is the most reliable
// trigger, so the designer prompts name it explicitly. Emitted only when the
// skill was installed for this session (Claude Code, designer specialists).
export const GUIDED_BRIEF_DESIGN_SKILL_ACTIVATION_LINE =
  'Use the `frontend-design` skill and hold to its craft guidance while authoring — restraint, one accent, hairline structure, real content, responsive and accessible floors, and the non-happy states.'

export type GuidedBriefSpecialistPromptInput =
  | {
      kind: 'strategist'
      ideaSeedPath?: string
      requirementsPath?: string
      marker?: string
      interviewProtocol?: GuidedBriefInterviewProtocol
    }
  | {
      kind: 'architect'
      ideaSeedPath?: string
      acceptedBriefSnapshotPath?: string | null
      architecturePlanPath?: string
      marker?: string
      interviewProtocol?: GuidedBriefInterviewProtocol
    }
  | {
      kind: 'designer'
      acceptedBriefSnapshotPath?: string
      acceptedArchitecturePlanPath?: string | null
      inspirationDirectoryPath?: string
      uiDirectionPath?: string
      mockupPath?: string
      marker?: string
      interviewProtocol?: GuidedBriefInterviewProtocol
      // True when the curated frontend-design skill was installed for this
      // session (Claude Code only): the designer prompt names it so Claude
      // Code activates it. Both designer variants (mockup + design-system)
      // honor it.
      designSkillActivation?: boolean
      // True when `design-system/` exists in the workspace (an attached
      // bundle): the mockup designer must conform to it instead of inventing
      // styles. Never set for the design-system authoring studio, which owns
      // that directory as its work product.
      designSystemAttached?: boolean
      // Design-system preset: the session authors a portable bundle instead
      // of one app's mockups, under a dedicated role prompt (not the shared
      // designer soul). See knowledge/multicode/design-system-bundle.md.
      designSystem?: {
        bundleDirectoryPath: string
        ideaSeedPath: string
        // Present when the studio was started as "seed from an existing
        // product": the agent's opening move is extracting the source's
        // de-facto design language into a starter bundle for review.
        seedSource?: DesignSystemSeedSource
      }
    }

function guidedBriefInterviewInstructions(
  role: 'product strategist' | 'architect' | 'frontend designer' | 'design-system designer',
  protocol: GuidedBriefInterviewProtocol = 'terminal-markers',
): string[] {
  const shared = [
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
  if (protocol === 'ask-user-question') {
    return [
      ...shared,
      // Conversation sessions intercept AskUserQuestion and render native
      // option cards — no stdout mirroring, no marker scraping.
      'Ask every interview question with the AskUserQuestion tool (one question per call): put the recommendation and its tradeoff in each option\'s description, and mark the recommended option by putting it first with "(Recommended)" appended to its label.',
      'Never print questions as plain text or as machine-readable stdout blocks; the AskUserQuestion tool is the only interview channel.',
      'After each answer, briefly acknowledge the decision in one sentence, then continue to the next question.',
    ]
  }
  return [
    ...shared,
    // Machine-readable mirror of the interview so the app renders native
    // question cards (parsed by interviewProtocol.ts). The fence tokens must
    // never appear alone on a line inside these instructions — the parser
    // treats a token alone on a line as a fence, and the CLI echoes this
    // prompt back through the PTY.
    'Additionally, mirror every question as a machine-readable block on stdout so the app can render native answer options: print a line containing only the token GUIDED_QUESTION_BEGIN, then a single JSON object, then a line containing only the token GUIDED_QUESTION_END.',
    'That JSON object has fields "id" (a stable string like "q1", unique per question), "question" (the question text), "options" (an array of objects with fields "key", "label", "detail", and optional "recommended": true on the first option), and optional "allowOther": true when a custom answer is sensible.',
    'Each option "key" is exactly the text the user would type in the terminal to choose that option (for example "1").',
    'After the block, also print the same question and options as normal readable text for the terminal.',
    'When the user answers a question (typed in the terminal or sent by the app), print one line that starts with the token GUIDED_DECISION: followed by a JSON object with fields "id" (the question id), "question", and "label" (the chosen option label or the custom answer) — then continue to the next question.',
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
      ...guidedBriefInterviewInstructions('product strategist', input.interviewProtocol),
      `Write the accepted product brief to \`${requirementsPath}\`.`,
      'After the brief is complete, additionally write a navigable HTML overview of it to `product/overview.html`: one self-contained file with no external dependencies (no CDN assets, web fonts, or scripts required to read it), summarizing users, scope, user flows, and MVP cut lines with anchor navigation between sections.',
      'Style the overview as a calm dark technical document: near-black background, one accent color, hairline borders, sentence case — no gradients or decorative motion.',
      'The overview is a rendering of the brief, not a second source of truth: it must not introduce or contradict anything in the markdown. The markdown brief remains the canonical artifact, and the readiness marker below must not wait for the overview.',
      `When and only when \`${requirementsPath}\` exists and is ready for user review, emit this exact marker on its own line:`,
      '',
      marker,
      '',
      'Do not create or mutate sprint state. This Guided brief flow hands off to a sprint later.',
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
      ...guidedBriefInterviewInstructions('architect', input.interviewProtocol),
      `Write the accepted architecture plan to \`${architecturePlanPath}\`.`,
      'The architecture plan must cover goal, confirmed requirements, assumptions, open questions, architecture direction, real data/source-of-truth contracts, UI/API/service contracts where relevant, implementation tasks, verification strategy, risks, migration or rollback notes where relevant, and deferred work.',
      'The plan must not depend on template data, sample data, hardcoded demo entities, fake API responses, placeholder persistence, mocked services, or stubbed commands outside tests.',
      'After the plan is complete, additionally write a navigable HTML overview of it to `architecture/overview.html`: one self-contained file with no external dependencies (no CDN assets, web fonts, or scripts required to read it), covering the system map, confirmed decisions as a table, implementation phases, and risks with anchor navigation between sections.',
      'Style the overview as a calm dark technical document: near-black background, one accent color, hairline borders, sentence case — no gradients or decorative motion.',
      'The overview is a rendering of the plan, not a second source of truth: it must not introduce or contradict anything in the markdown. The markdown plan remains the canonical artifact, and the readiness marker below must not wait for the overview.',
      `When and only when \`${architecturePlanPath}\` exists and is ready for user review, emit this exact marker on its own line:`,
      '',
      marker,
      '',
      'Do not create or mutate sprint state. This Guided brief flow hands off to a sprint later.',
      'If the `souls` command is unavailable, stop and report that the Souls CLI is unavailable instead of guessing the role prompt.',
    ].join('\n')
  }

  if (input.designSystem) {
    const marker = input.marker ?? 'DESIGN_SYSTEM_READY'
    const bundle = input.designSystem.bundleDirectoryPath
    const ideaSeedPath = input.designSystem.ideaSeedPath
    const seedSource = input.designSystem.seedSource
    const inspirationDirectoryPath = input.inspirationDirectoryPath ?? '.guided-brief/inspiration'

    // Seed-from-existing-product opening move. The extraction is a reviewed
    // draft, never a silent import: inferred semantics carry a `"seeded"`
    // marker in the vendor extension and the interview opens by confirming
    // them with the user (that metadata is what makes the system agent-usable
    // downstream). v1 source scope per the epic: CSS custom properties /
    // documented token values + glyphs + obvious components only.
    const seedSourceLines = seedSource
      ? [
          seedSource.kind === 'brand-demo'
            ? `This studio was seeded from the built-in Multicode brand reference at \`${seedSource.path}\`. Treat it as the existing product being distilled into a design system: its token values live in Markdown tables (\`design-tokens.md\`, \`workspace-themes.md\`), its glyph language in \`glyph-system.md\`, its principles in \`aesthetic-north-star.md\`, and its logo/icon SVGs in \`multicode-assets/\`.`
            : `This studio was seeded from an existing product at \`${seedSource.path}\`. Extract its de-facto design language instead of starting blank.`,
          'Before the first interview question, inspect the source and author a starter bundle from what is actually there: CSS custom properties (`:root` blocks and stylesheet files), documented token values, SVG glyphs, and the obvious repeated components (button, input, card). Extract only values the source contains — do not invent.',
          `Write the extraction as real files: reference and semantic DTCG tokens in \`${bundle}/foundations/tokens.tokens.json\` with both light and dark mode values (when the source defines only one mode, derive the other conservatively and flag it for review), the source's glyphs copied into \`${bundle}/glyphs/\` (one concept per file, fills converted to currentColor), and the two or three strongest candidate components under \`${bundle}/components/\`.`,
          'Every semantic meaning you infer — a token\'s role, use, or doNotUse — is a proposal until the user confirms it. Mark each inferred token by setting `"seeded": true` inside its `$extensions["com.multicode"]` metadata.',
          'Then open the interview by walking the user through the inferred semantics group by group (color, type, spacing, radius; then glyphs and candidate components): confirm or correct each, remove the `"seeded"` flag once the user confirms it, and say what you skipped in the source and why. This is a reviewed extraction, not a silent import.',
        ]
      : []

    return [
      'You are the design-system designer for this workspace: a senior design engineer who turns a brand direction into a portable, agent-usable design system bundle. This prompt is your role, judgment, and quality bar — it replaces the shared designer Soul; do not fetch one.',
      '',
      `Read the design goal at \`${ideaSeedPath}\` before asking follow-up questions.`,
      `Read \`${bundle}/USAGE.md\` before authoring anything — it is the bundle's consume-and-contribute contract, and every contribution you make must follow it: the naming grammar in \`${bundle}/design-system.json\`, full semantic metadata on tokens, the per-component template, and the lint gate.`,
      ...(input.designSkillActivation ? [GUIDED_BRIEF_DESIGN_SKILL_ACTIVATION_LINE] : []),
      `If the user has dropped inspiration files into \`${inspirationDirectoryPath}\`, read them through the existing CLI image-input path before drafting.`,
      ...seedSourceLines,
      ...guidedBriefInterviewInstructions('design-system designer', input.interviewProtocol),
      `Author the system as real files inside \`${bundle}/\`, walking it in this order with the user: design rules and principles (\`foundations/principles.md\`), design tokens (\`foundations/tokens.tokens.json\` — two tiers \`ref\`/\`sem\`, explicit \`$type\` and \`$description\` on every token, \`sem.*\` tokens carrying role/use metadata and light+dark modes as USAGE.md specifies), glyphs (\`glyphs/*.svg\`, one concept per file, currentColor), an open-ended component set (\`components/<name>/\` with component.html, component.css, component.md), and exemplar patterns (\`patterns/*.html\`).`,
      `Register every authored piece in \`${bundle}/design-system.json\` under \`contents\` as you go.`,
      `Never hand-edit the derived files (\`foundations/tokens.css\`, \`catalog/index.html\`). Regenerate them with the bundle's own scripts after source edits: \`node ${bundle}/scripts/build-tokens.mjs\` after token changes, \`node ${bundle}/scripts/build-catalog.mjs\` after component or pattern changes (skip it if that script is not present yet).`,
      `Run \`node ${bundle}/scripts/lint.mjs\` and fix every finding before declaring the bundle ready.`,
      `When and only when \`${bundle}/foundations/tokens.tokens.json\`, \`${bundle}/foundations/principles.md\`, and at least one component exist, the lint exits 0, and the bundle is ready for user review, emit this exact marker on its own line:`,
      '',
      marker,
      '',
      'Keep iterating with the user after the marker — the studio stays open for refining tokens, components, and patterns until they are satisfied.',
      'Do not introduce a new agent runtime protocol. Use only normal terminal stdout/stdin, prompt instructions, and this marker.',
      'Do not create or mutate sprint state.',
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
    ...(input.designSkillActivation ? [GUIDED_BRIEF_DESIGN_SKILL_ACTIVATION_LINE] : []),
    ...(input.designSystemAttached ? [DESIGN_SYSTEM_ATTACHED_PROMPT_LINE] : []),
    `If the user has dropped inspiration files into \`${inspirationDirectoryPath}\`, read them through the existing CLI image-input path before drafting.`,
    ...guidedBriefInterviewInstructions('frontend designer', input.interviewProtocol),
    `Write UX direction to \`${uiDirectionPath}\`.`,
    `Write the reviewable HTML mockup to \`${mockupPath}\`.`,
    `When and only when \`${uiDirectionPath}\` and the mockup HTML exist and are ready for user review, emit this exact marker on its own line:`,
    '',
    marker,
    '',
    'Do not introduce a new agent runtime protocol. Use only normal terminal stdout/stdin, prompt instructions, and this marker.',
    'Do not create or mutate sprint state. This Guided brief flow hands off to a sprint later.',
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
