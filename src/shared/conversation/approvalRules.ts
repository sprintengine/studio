import { inferConversationToolKind } from './toolKind'
import { labelCommand } from './commandLabel'
import type { ConversationToolKind } from '../conversation-runtime'

export type ConversationApprovalDecision = 'once' | 'conversation' | 'always' | 'deny'
export type ApprovalRuleRequest = {
  action: string
  input?: unknown
  toolKind?: ConversationToolKind
  requestKind?: string
}
export type ConversationApprovalRule = {
  id: string
  workspaceRoot: string
  toolKind: ConversationToolKind
  toolName: string
  matcher:
    | { type: 'program'; program: string }
    | { type: 'path'; prefix: string }
    | { type: 'mcp'; server: string; tool: string }
  label: string
  createdAt: number
}
export function approvalInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Unknown shell structure fails closed. A remembered program is not a shell grant. */
export function isNeverAutoApprovableCommand(command: string): boolean {
  if (!command.trim() || /[\u0000-\u001f;&|`<>\\$]/u.test(command)) return true
  const first = command.trim().split(/\s+/)[0]
  if (!/^[\w./-]+$/u.test(first)) return true
  // A display label drops paths and script extensions. They must not let a
  // repository-controlled executable inherit a grant for a different program.
  if (first.includes('/') || /\.(?:cmd|bat|sh|ps1)$/iu.test(first)) return true
  const program = first
    .split('/')
    .at(-1)!
    .toLowerCase()
    .replace(/\.exe$/u, '')
  if (
    /^(?:sudo|doas|su|rm|rmdir|del|erase|format|diskpart|diskutil|fdisk|sfdisk|parted|mkfs(?:\..*)?|dd|shred|wipefs|mount|umount|shutdown|reboot|eval|exec|env|command|builtin|time|timeout|nice|nohup|stdbuf|chroot|busybox|xargs|find|bash|sh|zsh|fish|dash|powershell|pwsh|cmd|python[\d.]*|node|ruby|perl|osascript)$/u.test(
      program,
    )
  )
    return true
  // Quoted/combined flags and abbreviated force forms are deliberately not
  // decoded as safe. The user can still approve any such request once.
  if (
    program === 'git' &&
    /(?:['"]|\bpush\b.*(?:--force|-f\b)|\b(?:clean|reset|restore|config|alias)\b|\s-c|--config-env|--exec-path|\bcheckout\b.*(?:--|\.|-f\b))/iu.test(
      command,
    )
  )
    return true
  return /\brm\s+[^\n]*(?:-[\w]*r[\w]*f|-[\w]*f[\w]*r|--recursive|--force)/iu.test(command)
}

function normalizedPath(value: string): string | null {
  const path = value.replace(/\\/gu, '/')
  if (!path.startsWith('/') && !/^[A-Za-z]:\//u.test(path)) return null
  const prefix = path.startsWith('/') ? '/' : path.slice(0, 3).toLowerCase()
  const parts: string[] = []
  for (const part of path.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return prefix + parts.join('/')
}
export function approvalFilePath(request: ApprovalRuleRequest, workspaceRoot: string): string | null {
  const input = approvalInput(request.input)
  const raw = input.file_path ?? input.path ?? input.filePath
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || raw.startsWith('~')) return null
  return normalizedPath(/^(?:\/|[A-Za-z]:[\\/])/u.test(raw) ? raw : `${workspaceRoot}/${raw}`)
}
export function isPathWithinApprovalRoot(path: string, root: string): boolean {
  const normalized = normalizedPath(root)
  return Boolean(normalized && (path === normalized || path.startsWith(`${normalized.replace(/\/$/u, '')}/`)))
}

export function approvalRuleCandidate(
  request: ApprovalRuleRequest,
  workspaceRoot: string,
): Omit<ConversationApprovalRule, 'id' | 'createdAt'> | null {
  if (request.requestKind && request.requestKind !== 'tool') return null
  const kind = request.toolKind ?? inferConversationToolKind(request.action)
  const input = approvalInput(request.input)
  const base = { workspaceRoot, toolKind: kind, toolName: request.action }
  if (kind === 'command') {
    const command = input.command ?? input.cmd
    if (typeof command !== 'string' || isNeverAutoApprovableCommand(command)) return null
    const program = labelCommand(command).program
    if (!program) return null
    return { ...base, matcher: { type: 'program', program }, label: `${request.action}: ${program}` }
  }
  if (kind === 'file_read' || kind === 'file_edit' || kind === 'file_write') {
    const path = approvalFilePath(request, workspaceRoot)
    const prefix = normalizedPath(workspaceRoot)
    if (!path || !prefix || !isPathWithinApprovalRoot(path, prefix) || Array.isArray(input.edits)) return null
    return { ...base, matcher: { type: 'path', prefix }, label: `${request.action}: files within ${prefix}` }
  }
  if (kind === 'mcp') {
    const match = /^mcp__(?<server>[\w.-]+)__(?<tool>[\w.-]+)$/u.exec(request.action)
    if (!match?.groups) return null
    return {
      ...base,
      matcher: { type: 'mcp', server: match.groups.server, tool: match.groups.tool },
      label: `${match.groups.server}: ${match.groups.tool}`,
    }
  }
  return null
}

export function matchesApprovalRule(
  rule: ConversationApprovalRule,
  request: ApprovalRuleRequest,
  workspaceRoot: string,
): boolean {
  const candidate = approvalRuleCandidate(request, workspaceRoot)
  if (
    !candidate ||
    rule.workspaceRoot !== workspaceRoot ||
    rule.toolKind !== candidate.toolKind ||
    rule.toolName !== candidate.toolName ||
    rule.matcher.type !== candidate.matcher.type
  )
    return false
  return JSON.stringify(rule.matcher) === JSON.stringify(candidate.matcher)
}

export function isConversationApprovalRule(value: unknown): value is ConversationApprovalRule {
  const rule = approvalInput(value)
  const matcher = approvalInput(rule.matcher)
  if (
    typeof rule.id !== 'string' ||
    typeof rule.workspaceRoot !== 'string' ||
    typeof rule.toolName !== 'string' ||
    typeof rule.label !== 'string' ||
    typeof rule.createdAt !== 'number'
  )
    return false
  return (
    (rule.toolKind === 'command' &&
      matcher.type === 'program' &&
      typeof matcher.program === 'string' &&
      /^[\w./-]+$/u.test(matcher.program)) ||
    (['file_read', 'file_edit', 'file_write'].includes(String(rule.toolKind)) &&
      matcher.type === 'path' &&
      matcher.prefix === normalizedPath(rule.workspaceRoot)) ||
    (rule.toolKind === 'mcp' &&
      matcher.type === 'mcp' &&
      typeof matcher.server === 'string' &&
      typeof matcher.tool === 'string')
  )
}
