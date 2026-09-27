import { inferConversationToolKind } from './toolKind'
import type { ConversationToolKind } from '../conversation-runtime'

export type ConversationApprovalDecision = 'once' | 'conversation' | 'always' | 'deny'
export type ApprovalRuleRequest = {
  action: string
  input?: unknown
  toolKind?: ConversationToolKind
  requestKind?: string
  defaultToNo?: boolean
  suppressAlwaysAllowRule?: boolean
}
/**
 * `subcommand` absent means any arguments to a program whose arguments are
 * data (`rg`, `ls`); an empty string means the bare program with no arguments.
 */
type ApprovalCommandMatcher = { type: 'command'; program: string; subcommand?: string }
export type ConversationApprovalRule = {
  id: string
  workspaceRoot: string
  toolKind: ConversationToolKind
  toolName: string
  matcher: ApprovalCommandMatcher | { type: 'path'; prefix: string } | { type: 'mcp'; server: string; tool: string }
  label: string
  createdAt: number
}
export function approvalInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

// Programs whose arguments are data rather than an action, so one grant for
// the program cannot widen into a different kind of operation.
const ARGUMENT_PROGRAMS = new Set([
  'rg',
  'grep',
  'egrep',
  'fgrep',
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'tree',
  'stat',
  'file',
  'du',
  'df',
  'which',
  'echo',
  'printf',
  'diff',
  'cmp',
  'basename',
  'dirname',
  'realpath',
  'date',
  'uname',
  'vitest',
  'jest',
  'pytest',
  'mocha',
  'eslint',
  'oxlint',
  'prettier',
  'tsc',
])
// Shells, interpreters, privilege and process wrappers, package runners, and
// tools that write or move arbitrary paths or reach the network: a grant for
// any of these is a grant for arbitrary code or arbitrary files.
const NEVER_PROGRAMS =
  /^(?:sudo|doas|su|rm|rmdir|del|erase|format|diskpart|diskutil|fdisk|sfdisk|parted|mkfs(?:\..*)?|dd|shred|wipefs|mount|umount|shutdown|reboot|eval|exec|env|command|builtin|time|timeout|nice|nohup|stdbuf|chroot|busybox|xargs|find|bash|sh|zsh|fish|dash|ksh|csh|tcsh|powershell|pwsh|cmd|python[\d.]*|node|deno|tsx|ts-node|ruby|perl|php|lua|osascript|npx|bunx|pnpx|uvx|pipx|cp|mv|ln|chmod|chown|chgrp|touch|tee|install|rsync|scp|sftp|ssh|curl|wget|nc|ncat|socat|telnet|open|xdg-open|start|kill|killall|pkill|launchctl|systemctl|defaults|crontab|at|tar|unzip|zip|gzip|gunzip|sed|awk|gawk|sort|security|sqlite3|vi|vim|nvim|nano|emacs|less|more|man|watch|parallel|script|expect)$/u
// Flags that load or run code, rewrite configuration, or write a file chosen
// by the caller, on whichever program accepts them.
const NEVER_LONG_FLAGS =
  /^--(?:exec|exec-path|upload-pack|receive-pack|config|config-env|output|output-file|out-file|pre|to-command|checkpoint-action|compress-program|use-compress-program|rsh|script-shell|node-options|require|import|loader|eval|template|git-dir|work-tree|open-files-in-pager|extcmd)(?:=|$)/iu

type Scope = { program: string; subcommand?: string }

/**
 * Split a command the way a POSIX shell would for the simple cases, and refuse
 * everything else: any operator, redirection, substitution, glob, escape or
 * home expansion leaves the candidate unrememberable rather than guessed at.
 */
function commandWords(command: string): string[] | null {
  if (!command.trim() || /[\u0000-\u001f\u007f`$\\]/u.test(command)) return null
  const words: string[] = []
  let word = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null
      else if (quote === '"' && char === '!') return null
      else word += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (char === ' ') {
      if (started) words.push(word)
      word = ''
      started = false
    } else if (/[\p{L}\p{N}_./:=@%+,-]/u.test(char)) {
      word += char
      started = true
    } else return null
  }
  if (quote) return null
  if (started) words.push(word)
  return words.length ? words : null
}

function touchesGitDirectory(word: string): boolean {
  // Case-insensitive because the default macOS and Windows file systems are.
  return word.split(/[/=:,]/u).some((part) => /^\.git[.\s]*$/iu.test(part))
}

function shortFlags(word: string): string {
  return /^-(?!-)([A-Za-z]+)/u.exec(word)?.[1] ?? ''
}

const GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'show',
  'diff',
  'blame',
  'shortlog',
  'describe',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'cat-file',
  'show-ref',
  'merge-base',
  'name-rev',
  'reflog',
  'grep',
  'add',
  'commit',
  'mv',
  'fetch',
  'pull',
  'push',
  'branch',
  'switch',
  'stash',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'tag',
  'remote',
  'worktree',
  'reset',
])
// Subcommands whose own first word is a different operation (`stash drop`).
const GIT_NESTED = new Set(['stash', 'remote', 'worktree', 'reflog'])
const GIT_DENIED: Record<string, { short?: string; long?: RegExp; nested?: RegExp; positional?: RegExp }> = {
  fetch: { short: 'u' },
  pull: { short: 'u' },
  // `+ref` and `:ref` are force and delete written as a refspec.
  push: { short: 'fd', long: /^--(?:force|delete|mirror|prune)/u, positional: /^[+:]/u },
  branch: { short: 'DMCf', long: /^--force/u },
  tag: { short: 'df', long: /^--(?:delete|force)/u },
  reset: { long: /^--(?:hard|merge|keep)(?:=|$)/u },
  rebase: { short: 'xi', long: /^--(?:interactive)(?:=|$)/u },
  grep: { short: 'O' },
  switch: { short: 'fC', long: /^--(?:force|discard-changes)/u },
  mv: { short: 'f', long: /^--force/u },
  stash: { nested: /^(?:drop|clear)$/u },
  reflog: { nested: /^(?:expire|delete)$/u },
  worktree: { short: 'f', long: /^--force/u },
}

function gitScope(args: string[]): Scope | null {
  // Options before the subcommand redirect the repository or its config.
  const rest = args[0] === '--no-pager' ? args.slice(1) : args
  const subcommand = rest[0]
  if (!subcommand || !GIT_SUBCOMMANDS.has(subcommand)) return null
  const tail = rest.slice(1)
  const denied = GIT_DENIED[subcommand] ?? {}
  let positional = false
  for (const arg of tail) {
    if (arg === '--') {
      positional = true
      continue
    }
    if (!positional && arg.startsWith('-')) {
      if (arg.startsWith('-o') || arg.startsWith('--push-option')) return null
      if (denied.long?.test(arg)) return null
      if (denied.short && [...shortFlags(arg)].some((flag) => denied.short!.includes(flag))) return null
    } else if (denied.positional?.test(arg)) return null
  }
  if (!GIT_NESTED.has(subcommand)) return { program: 'git', subcommand }
  const nested = tail.find((arg) => !arg.startsWith('-'))
  if (nested && denied.nested?.test(nested)) return null
  return { program: 'git', subcommand: nested ? `${subcommand} ${nested}` : subcommand }
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PACKAGE_RUN = new Set(['run', 'run-script', 'rum', 'urn'])
// Each runs a package or program named in its arguments, or rewrites the
// configuration that every later script inherits.
const PACKAGE_DENIED = new Set([
  'exec',
  'x',
  'dlx',
  'create',
  'init',
  'explore',
  'edit',
  'config',
  'c',
  'set',
  'pkg',
  'node',
])
const PACKAGE_INSTALL = /^(?:install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|ci|update|up|upgrade)$/u
const PACKAGE_FLAGS = new Set([
  '-s',
  '--silent',
  '--if-present',
  '--frozen-lockfile',
  '--immutable',
  '--prefer-offline',
  '--offline',
  '--no-audit',
  '--no-fund',
  '--ignore-scripts',
  '-r',
  '--recursive',
  '--parallel',
  '--stream',
])

function packageScope(program: string, args: string[]): Scope | null {
  const subcommand = args[0]
  if (!subcommand) return { program, subcommand: '' }
  if (subcommand.startsWith('-') || PACKAGE_DENIED.has(subcommand)) return null
  const separator = args.indexOf('--')
  const own = separator === -1 ? args.slice(1) : args.slice(1, separator)
  if (own.some((arg) => arg.startsWith('-') && !PACKAGE_FLAGS.has(arg))) return null
  const positional = own.filter((arg) => !arg.startsWith('-'))
  // Installing a named package runs that package's lifecycle scripts.
  if (PACKAGE_INSTALL.test(subcommand)) return positional.length ? null : { program, subcommand }
  if (PACKAGE_RUN.has(subcommand)) return { program, subcommand: positional[0] ? `run ${positional[0]}` : 'run' }
  return { program, subcommand }
}

function commandScope(command: string): Scope | null {
  const words = commandWords(command)
  if (!words) return null
  const first = words[0]
  // A leading `NAME=value` sets the environment (`GIT_SSH_COMMAND=...`), and a
  // path or script extension names a repository-controlled executable.
  if (!/^[\w.-]+$/u.test(first) || /\.(?:cmd|bat|sh|ps1)$/iu.test(first)) return null
  const program = first.toLowerCase().replace(/\.exe$/u, '')
  if (NEVER_PROGRAMS.test(program)) return null
  const args = words.slice(1)
  if (args.some((arg) => NEVER_LONG_FLAGS.test(arg) || touchesGitDirectory(arg))) return null
  if (program === 'git') return gitScope(args)
  if (PACKAGE_MANAGERS.has(program)) return packageScope(program, args)
  if (ARGUMENT_PROGRAMS.has(program)) {
    if (program === 'tree' && args.some((arg) => shortFlags(arg).includes('o'))) return null
    if (program === 'eslint' && args.some((arg) => arg === '-o')) return null
    return { program }
  }
  // Anything else is scoped to its first word; a leading option leaves the
  // action unknown, so that request can only be allowed once.
  const subcommand = args[0]
  if (subcommand === undefined) return { program, subcommand: '' }
  if (!/^[\w.:@-]+$/u.test(subcommand) || subcommand.startsWith('-')) return null
  return { program, subcommand }
}

/** Unknown shell structure fails closed. A remembered command is never a shell grant. */
export function isNeverAutoApprovableCommand(command: string): boolean {
  return commandScope(command) === null
}

function commandText(matcher: ApprovalCommandMatcher): string {
  if (matcher.subcommand === undefined) return `"${matcher.program} …"`
  if (!matcher.subcommand) return `"${matcher.program}" with no arguments`
  return `"${matcher.program} ${matcher.subcommand} …"`
}

/** What a remembered rule grants, in the words the permission menu and Settings use. */
function approvalRuleScopeText(rule: Pick<ConversationApprovalRule, 'toolName' | 'matcher'>): string {
  const { matcher } = rule
  if (matcher.type === 'command') return commandText(matcher)
  if (matcher.type === 'path') return `${rule.toolName} on any file in this workspace except .git`
  return `${matcher.server} ${matcher.tool}`
}

/** Menu wording for the two remember choices of a permission request. */
export function approvalRememberLabels(rule: Pick<ConversationApprovalRule, 'toolName' | 'matcher'>): {
  conversation: string
  always: string
} {
  const scope = approvalRuleScopeText(rule)
  return { conversation: `Allow ${scope} for this conversation`, always: `Always allow ${scope} in this workspace` }
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
/**
 * A file grant never reaches into a repository's git directory: a planted hook
 * or `core.hooksPath` runs on the user's next commit, outside any approval.
 */
export function isApprovalPathInGitDirectory(path: string, root: string): boolean {
  const normalizedRoot = normalizedPath(root)
  if (!normalizedRoot) return true
  return path
    .slice(normalizedRoot.length)
    .split('/')
    .some((part) => /^\.git[.\s]*$/iu.test(part))
}

export function approvalRuleCandidate(
  request: ApprovalRuleRequest,
  workspaceRoot: string,
): Omit<ConversationApprovalRule, 'id' | 'createdAt'> | null {
  if (request.requestKind && request.requestKind !== 'tool') return null
  if (request.defaultToNo || request.suppressAlwaysAllowRule) return null
  const kind = request.toolKind ?? inferConversationToolKind(request.action)
  const input = approvalInput(request.input)
  const base = { workspaceRoot, toolKind: kind, toolName: request.action }
  if (kind === 'command') {
    const command = input.command ?? input.cmd
    if (typeof command !== 'string') return null
    const scope = commandScope(command)
    if (!scope) return null
    const matcher: ApprovalCommandMatcher = { type: 'command', ...scope }
    return { ...base, matcher, label: `${request.action}: ${commandText(matcher)}` }
  }
  if (kind === 'file_read' || kind === 'file_edit' || kind === 'file_write') {
    const path = approvalFilePath(request, workspaceRoot)
    const prefix = normalizedPath(workspaceRoot)
    if (!path || !prefix || !isPathWithinApprovalRoot(path, prefix) || Array.isArray(input.edits)) return null
    if (isApprovalPathInGitDirectory(path, prefix)) return null
    const matcher = { type: 'path' as const, prefix }
    return { ...base, matcher, label: `${request.action}: files within ${prefix} except .git` }
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
  if (rule.matcher.type === 'command' && candidate.matcher.type === 'command')
    return (
      rule.matcher.program === candidate.matcher.program && rule.matcher.subcommand === candidate.matcher.subcommand
    )
  return JSON.stringify(rule.matcher) === JSON.stringify(candidate.matcher)
}

function isConversationApprovalRule(value: unknown): value is ConversationApprovalRule {
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
      matcher.type === 'command' &&
      typeof matcher.program === 'string' &&
      /^[\w.-]+$/u.test(matcher.program) &&
      (matcher.subcommand === undefined || typeof matcher.subcommand === 'string')) ||
    (['file_read', 'file_edit', 'file_write'].includes(String(rule.toolKind)) &&
      matcher.type === 'path' &&
      matcher.prefix === normalizedPath(rule.workspaceRoot)) ||
    (rule.toolKind === 'mcp' &&
      matcher.type === 'mcp' &&
      typeof matcher.server === 'string' &&
      typeof matcher.tool === 'string')
  )
}

/**
 * Rules saved before command grants named a subcommand matched every use of
 * the program. Keep only those whose program takes data rather than an action;
 * the rest cannot be narrowed without knowing what was approved, so they are
 * dropped and the next request asks again. Returns null for a rule to drop.
 */
export function migrateConversationApprovalRule(value: unknown): ConversationApprovalRule | null {
  if (isConversationApprovalRule(value)) return value
  const rule = approvalInput(value)
  const matcher = approvalInput(rule.matcher)
  if (rule.toolKind !== 'command' || matcher.type !== 'program' || typeof matcher.program !== 'string') return null
  const program = matcher.program.toLowerCase()
  if (!ARGUMENT_PROGRAMS.has(program) || typeof rule.toolName !== 'string') return null
  const next = {
    ...rule,
    matcher: { type: 'command', program },
    label: `${rule.toolName}: ${commandText({ type: 'command', program })}`,
  }
  return isConversationApprovalRule(next) ? next : null
}
