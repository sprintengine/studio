// What a chat's permission mode answers on the app's side.
//
// Each runtime is told the mode in its own words when its child starts (a
// flag, an approval policy, a rule set), and the ones that can take it over
// their protocol are told again when it changes. That is the first line. This
// is the second: a request that still reaches the app is answered here when the
// mode already answers it, so a mode means the same thing on every runtime and
// from the moment it is chosen, even on a runtime that only takes the change at
// its next turn. A switch mid-reply answers the requests already waiting the
// same way.
//
// It only ever allows. A mode stricter than the one a runtime's child is
// running under cannot be enforced from here for what the child does without
// asking; the provider says so with a notice, and the stricter mode reaches the
// child at its next turn.

import type { ConversationPermissionPreset } from '../conversation-runtime'
import { inferConversationToolKind } from './toolKind'
import {
  approvalFilePath,
  approvalInput,
  isAgentLaunchingGatewayTool,
  isApprovalPathInGitDirectory,
  isPathWithinApprovalRoot,
  mcpCallOf,
  type ApprovalRuleRequest,
} from './approvalRules'

/** A request as the mode reads it. `mustAsk` is a runtime saying a person has to answer it. */
export type PermissionModeRequest = ApprovalRuleRequest & { mustAsk?: boolean }

/**
 * Read-only lookups and the agent's own to-do list: what Manual still lets run
 * without a card, and what Auto lets run anywhere inside the workspace.
 */
export const LOOKUP_TOOL_KINDS: ReadonlySet<string> = new Set(['file_read', 'search', 'list', 'todo'])
const AUTO_EDIT_KINDS = new Set(['file_edit', 'file_write'])

/**
 * Whether `mode` answers `request` yes without asking.
 *
 * - Questions and plans are answers, not permissions: no mode answers them.
 * - A request the runtime marks as needing a person (a safety check it will
 *   not let a stray keystroke pass, or the person's own "always ask" rule) is
 *   never answered either.
 * - `bypass` answers every other tool request.
 * - `auto` answers the agent's to-do list, MCP tools other than the gateway's
 *   agent-launching ones, reads, searches and listings whose every place is
 *   inside the workspace, and edits whose every file (and every file one is
 *   moved to) is inside it; never its git directory. Commands, the network,
 *   subagents and anything it cannot place ask: a lookup
 *   that names no place it can resolve asks, and so does one that mentions a
 *   path outside the workspace anywhere in its input, whatever key the runtime
 *   put it under. (An edit's content is text for the file, not a place, so an
 *   edit is placed by the files it names.)
 * - `manual` and `none` answer nothing: the person decides.
 */
export function permissionModeAllows(
  mode: ConversationPermissionPreset | undefined,
  request: PermissionModeRequest,
  workspaceRoot: string,
): boolean {
  if (!mode || mode === 'none' || mode === 'manual') return false
  if (request.requestKind && request.requestKind !== 'tool') return false
  if (request.mustAsk || request.defaultToNo) return false
  if (mode === 'bypass') return true
  if (request.suppressAlwaysAllowRule || !workspaceRoot) return false
  const kind = request.toolKind ?? inferConversationToolKind(request.action)
  if (kind === 'todo') return true
  // An MCP tool is one the person connected on purpose, and asking before every
  // call to it was most of what Auto still asked (owner ruling 2026-10-01).
  // Never the gateway tools that start an agent or give one a workspace: each
  // hands a prompt of the caller's choosing to an agent that then acts on its
  // own, which no remembered grant covers either. A name the checks cannot read
  // as an MCP call asks.
  if (kind === 'mcp') {
    const call = mcpCallOf(request.action)
    return call !== null && !isAgentLaunchingGatewayTool(call.server, call.tool)
  }
  const paths = LOOKUP_TOOL_KINDS.has(kind)
    ? mentionsOutside(request.input, workspaceRoot)
      ? null
      : lookedUpPaths(request, workspaceRoot)
    : AUTO_EDIT_KINDS.has(kind)
      ? editedPaths(request, workspaceRoot)
      : null
  return (
    paths !== null &&
    paths.length > 0 &&
    paths.every(
      (path) => isPathWithinApprovalRoot(path, workspaceRoot) && !isApprovalPathInGitDirectory(path, workspaceRoot),
    )
  )
}

const PERMISSION_MODE_NAMES: Record<ConversationPermissionPreset, string> = {
  bypass: 'Bypass permissions',
  auto: 'Auto',
  manual: 'Manual',
  none: 'No flag',
}

/**
 * What a chat says when its runtime would not start under the mode it was
 * given and it was started again with no permission setting, so the person
 * learns why the chip reads No flag and what that means for what it asks.
 */
export function permissionFallbackNotice(runtime: string, from: ConversationPermissionPreset, error: string): string {
  const reason = error.trim().split('\n')[0]?.trim() ?? ''
  const clipped = reason.length > 200 ? `${reason.slice(0, 199)}…` : reason
  return (
    `${runtime} would not start with ${PERMISSION_MODE_NAMES[from]}, so this chat runs with no permission flag: ` +
    `${runtime}'s own settings decide what it asks about. Pick a mode again from the chat box to retry it.` +
    (clipped ? ` (${clipped})` : '')
  )
}

/** The line an automatically answered request carries: "Auto-approved: <this>". */
export function permissionModeApprovalLabel(mode: ConversationPermissionPreset): string {
  return mode === 'bypass' ? 'Bypass permissions mode' : mode === 'auto' ? 'Auto mode' : `${mode} mode`
}

// Whether any string in a request's input names a location outside the
// workspace: an absolute path, a home path or a climb out of it, in any field.
// A runtime is free to name its file under a key this module does not know
// (`target_file`, a glob's pattern), so the input is read whole.
function mentionsOutside(value: unknown, workspaceRoot: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => mentionsOutside(entry, workspaceRoot))
  if (value && typeof value === 'object')
    return Object.values(value).some((entry) => mentionsOutside(entry, workspaceRoot))
  if (typeof value !== 'string') return false
  return value.split(/[\s'"`;|,=()]+/u).some((token) => {
    if (token.startsWith('~')) return true
    // An absolute path, or one that climbs anywhere in it (`docs/../../x`).
    if (!/^(?:\/|[A-Za-z]:[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(token)) return false
    const path = approvalFilePath({ action: '', input: { path: token } }, workspaceRoot)
    return !path || !isPathWithinApprovalRoot(path, workspaceRoot)
  })
}

const PATH_KEYS = ['file_path', 'path', 'filePath', 'notebook_path'] as const

function namedPath(input: Record<string, unknown>): boolean {
  return PATH_KEYS.some((key) => typeof input[key] === 'string' && input[key] !== '')
}

// Every place a lookup reads, or null when one of them cannot be placed: the
// file it names, and the locations its runtime listed beside the input (an ACP
// agent's `toolCall.locations`). A search that names neither runs where the
// agent does, the workspace; any other lookup that names neither is not placed.
function lookedUpPaths(request: PermissionModeRequest, workspaceRoot: string): string[] | null {
  const input = approvalInput(request.input)
  const paths: string[] = []
  if (namedPath(input)) {
    const path = approvalFilePath(request, workspaceRoot)
    if (!path) return null
    paths.push(path)
  }
  if (Array.isArray(input.locations)) {
    for (const location of input.locations) {
      const path = approvalFilePath({ action: request.action, input: location }, workspaceRoot)
      if (!path) return null
      paths.push(path)
    }
  }
  if (paths.length === 0 && (hasText(input.pattern) || hasText(input.query))) paths.push(workspaceRoot)
  return paths
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

// Every file an edit request touches, or null when one of them cannot be
// placed. A request names its file at the top (`file_path`), per edit
// (`edits[].path`, a patch across files), or both; an edit that names none is
// an edit of the top-level file. An edit that moves its file (`movePath`)
// touches the destination too.
function editedPaths(request: PermissionModeRequest, workspaceRoot: string): string[] | null {
  const input = approvalInput(request.input)
  const top = namedPath(input) ? approvalFilePath(request, workspaceRoot) : undefined
  if (top === null) return null
  if (!Array.isArray(input.edits)) return top ? [top] : null
  const paths = top ? [top] : []
  for (const edit of input.edits) {
    const entry = approvalInput(edit)
    if (!namedPath(entry)) {
      if (!top) return null
      continue
    }
    const path = approvalFilePath({ action: request.action, input: entry }, workspaceRoot)
    if (!path) return null
    paths.push(path)
    if (entry.movePath !== undefined) {
      const destination =
        typeof entry.movePath === 'string'
          ? approvalFilePath({ action: request.action, input: { path: entry.movePath } }, workspaceRoot)
          : null
      if (!destination) return null
      paths.push(destination)
    }
  }
  return paths
}
