import type { ConversationWireCommand, ConversationWirePermissionPreset } from './index.js'

// The commands a client sends a conversation, and the answers it gives one.
//
// `ConversationWireCommand` (index.ts) is what every desktop since the lane
// shipped takes. The commands here extend it, each behind its own capability,
// so a client sends one only to a desktop that advertised it; a desktop
// without it refuses an unknown kind as `unsupported_command` and drops an
// unknown member, which is the fallback each extension below is shaped for.

/**
 * An answer to a `tool` permission request: allow this request `once`, allow
 * requests of its kind for the rest of the `conversation`, or `deny` it. A
 * rule that outlives the conversation is the person's to make on the desktop
 * itself, and no client can choose one.
 */
export type ConversationRequestDecision = 'once' | 'conversation' | 'deny'

/** Every decision a client may send, narrowest first. */
export const CONVERSATION_REQUEST_DECISIONS: readonly ConversationRequestDecision[] = ['once', 'conversation', 'deny']

/** An answer to a `plan` request: carry the plan out, or send the agent back to planning. */
export type ConversationPlanDecision = 'approve' | 'reject'

/** A question's answers: the question's text to the chosen answer (several comma-separated, free text verbatim). */
export type ConversationQuestionAnswers = Record<string, string>

/**
 * A command, from the full contract. Beyond the wire's own:
 *
 * - `setPermissionPreset` may name the CLI's own `permissionMode` at that
 *   preset (Claude Code's Accept edits, Codex's Workspace). Needs
 *   `conversation-cli-permission-modes`; a desktop without it ignores the
 *   member and runs the preset's own mode. A mode whose level is not the
 *   preset runs the preset's own as well.
 * - `resolvePlan` answers a `plan` request and only a plan request. Needs
 *   `conversation-plans`; before it, a plan was answered as a `resolveApproval`
 *   (`once` carries it out, `deny` rejects it), which every desktop still takes.
 */
export type ConversationCommand =
  | Exclude<ConversationWireCommand, { kind: 'setPermissionPreset' }>
  | { kind: 'setPermissionPreset'; preset: ConversationWirePermissionPreset; permissionMode?: string }
  | { kind: 'resolvePlan'; requestId: string; decision: ConversationPlanDecision }

export type ConversationCommandKind = ConversationCommand['kind']

/** Every command kind this version of the contract defines. */
export const CONVERSATION_COMMAND_KINDS: readonly ConversationCommandKind[] = [
  'send',
  'interrupt',
  'resolveApproval',
  'answerQuestion',
  'resolvePlan',
  'setPermissionPreset',
  'setModel',
]

/**
 * What starting a conversation takes. A transport adds what it carries
 * besides (a module's in-process pictures, a socket's upload ids); these
 * members mean the same everywhere.
 */
export type ConversationCreateRequest = {
  workspaceId: string
  /** The agent CLI the chat runs on; absent, the one the person last chose. */
  cli?: string
  /** The CLI's model id; absent, the CLI's own default. */
  model?: string
  /** The opening turn. Absent, the chat starts without one. */
  prompt?: string
  /** Display name; absent, the desktop picks one. */
  name?: string
  /** Skill ids installed before the first turn and invoked in it. */
  skills?: string[]
  /** Absent, the person's own default. A desktop may lower it to the caller's ceiling. */
  permissionPreset?: ConversationWirePermissionPreset
  /** The CLI's own mode at `permissionPreset`; read only beside it. */
  permissionMode?: string
  /**
   * Tools the chat may use without asking, by the name its CLI gives them
   * (`Write`, `Edit`). Questions and plans still ask. A CLI that cannot take
   * the list ignores it and asks as its preset says, which is never looser.
   */
  allowedTools?: string[]
}

/** The most tools `allowedTools` names. */
export const CONVERSATION_MAX_ALLOWED_TOOLS = 64
/** The most skills a create names. */
export const CONVERSATION_MAX_CREATE_SKILLS = 32

// What a CLI may call one of its own modes: short, and nothing a path, a flag
// or a markup fragment could be read as.
const PERMISSION_MODE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
// A tool name, or a CLI's pattern over one (`Bash(npm test:*)`): printable,
// one line, bounded, with no space at either end.
function toolName(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 200 || value.trim() !== value) return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** Whether a value can be a CLI's own permission mode id. A desktop checks it against the chat's CLI as well. */
export function isConversationPermissionModeId(value: unknown): value is string {
  return typeof value === 'string' && PERMISSION_MODE.test(value)
}

/** Whether a value is a usable `allowedTools` list. */
export function isConversationAllowedTools(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= CONVERSATION_MAX_ALLOWED_TOOLS && value.every(toolName)
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

/**
 * Validate a create request at a trust boundary, keeping only the members the
 * contract defines. The refusal names the member, so a caller can fix it.
 */
export function parseConversationCreateRequest(
  value: unknown,
): { ok: true; request: ConversationCreateRequest } | { ok: false; field: string; message: string } {
  const refuse = (field: string, message: string) => ({ ok: false as const, field, message })
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return refuse('', 'A create request is an object.')
  const input = value as Record<string, unknown>
  if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim() || input.workspaceId.length > 200)
    return refuse('workspaceId', '"workspaceId" is required.')
  for (const [field, max] of [
    ['cli', 200],
    ['model', 400],
    ['name', 200],
    ['prompt', 200_000],
  ] as const) {
    if (input[field] !== undefined && !text(input[field], max))
      return refuse(field, `"${field}" must be a string of at most ${max} characters.`)
  }
  if (
    input.skills !== undefined &&
    !(
      Array.isArray(input.skills) &&
      input.skills.length <= CONVERSATION_MAX_CREATE_SKILLS &&
      input.skills.every((skill) => typeof skill === 'string' && skill.trim() !== '' && skill.length <= 200)
    )
  )
    return refuse('skills', '"skills" must be a list of skill ids.')
  if (
    input.permissionPreset !== undefined &&
    !['none', 'manual', 'auto', 'bypass'].includes(input.permissionPreset as string)
  )
    return refuse('permissionPreset', '"permissionPreset" must be "none", "manual", "auto" or "bypass".')
  if (input.permissionMode !== undefined && !isConversationPermissionModeId(input.permissionMode))
    return refuse('permissionMode', '"permissionMode" must be one of the CLI\'s own mode ids.')
  if (input.allowedTools !== undefined && !isConversationAllowedTools(input.allowedTools))
    return refuse(
      'allowedTools',
      `"allowedTools" must be a list of at most ${CONVERSATION_MAX_ALLOWED_TOOLS} tool names.`,
    )
  return {
    ok: true,
    request: {
      workspaceId: input.workspaceId.trim(),
      ...(input.cli === undefined ? {} : { cli: input.cli as string }),
      ...(input.model === undefined ? {} : { model: input.model as string }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt as string }),
      ...(input.name === undefined ? {} : { name: input.name as string }),
      ...(input.skills === undefined ? {} : { skills: [...(input.skills as string[])] }),
      ...(input.permissionPreset === undefined
        ? {}
        : { permissionPreset: input.permissionPreset as ConversationWirePermissionPreset }),
      // A mode rides only beside a preset, as everywhere else.
      ...(input.permissionMode === undefined || input.permissionPreset === undefined
        ? {}
        : { permissionMode: input.permissionMode as string }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: [...(input.allowedTools as string[])] }),
    },
  }
}
