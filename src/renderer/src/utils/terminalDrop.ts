import type {
  BuiltinSkillTargetState,
  SkillHarness,
} from '../../../shared/electron-api'
import type { PluginRegistryListEntry } from '../../../shared/plugin-manifest'
import type { AgentSkill } from '../../../shared/skills'
import { plainSkillInvocation } from '../../../shared/skill-invocation'
import {
  hasInstalledNativeSkillTarget,
  renderSkillInvocationTemplate,
} from './skillInvocation'

export const MULTICODE_FILE_DROP_MIME = 'application/x-multicode-file-drop'
export const MULTICODE_COMMIT_DROP_MIME = 'application/x-multicode-commit-drop'
export const MULTICODE_SKILL_DROP_MIME = 'application/x-multicode-skill-drop'

export const BACKLOG_SKILL_ID = 'backlog'

export type FileDropPayload = {
  version: 1
  workspaceId: string | null
  rootPath: string
  files: Array<{
    path: string
    name: string
    isDir?: boolean
  }>
}

/**
 * A skill dragged out of the Skills pane onto a terminal. It carries the id and
 * the pane's workspace, never a rendered invocation: the form the agent reads
 * belongs to the session it lands on, not to the pane it left.
 */
export type SkillDropPayload = {
  version: 1
  skillId: string
  workspaceId: string | null
}

// Identifies a drop that handed a single backlog/ item to an agent terminal, so
// the caller can record the Backlog item ↔ agent link on both sides. Present
// only for real handoffs (see backlogItemDropDescriptor for the gating).
export type BacklogDropDescriptor = {
  relativePath: string
  agentId: string
  workspaceRoot: string
}

export type TerminalDropResult =
  | { ok: true; text: string; backlog?: BacklogDropDescriptor }
  | { ok: false; message: string }

export function setFileDropData(
  dataTransfer: DataTransfer,
  payload: FileDropPayload
): void {
  const fileText = payload.files.map((file) => file.path).join('\n')
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(MULTICODE_FILE_DROP_MIME, JSON.stringify(payload))
  dataTransfer.setData('text/plain', fileText)
}

export function hasFileDropData(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types)
  return types.includes(MULTICODE_FILE_DROP_MIME) || types.includes('Files')
}

export function setCommitDropData(dataTransfer: DataTransfer, hash: string): void {
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(MULTICODE_COMMIT_DROP_MIME, hash)
  dataTransfer.setData('text/plain', hash)
}

export function hasCommitDropData(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(MULTICODE_COMMIT_DROP_MIME)
}

export async function pasteDroppedCommitIntoTerminal(input: {
  dataTransfer: DataTransfer
  sessionId: string
}): Promise<TerminalDropResult> {
  const hash = parseCommitDropHash(input.dataTransfer)
  if (!hash) return { ok: false, message: 'No commit hash was dropped.' }

  const sessions = await window.api.terminalList()
  const session = sessions.find(
    (candidate) => candidate.sessionId === input.sessionId && candidate.processAlive
  )
  if (!session) return { ok: false, message: 'Terminal session is no longer running.' }

  await window.api.terminalWrite(input.sessionId, bracketedPaste(hash))
  return { ok: true, text: hash }
}

function parseCommitDropHash(dataTransfer: DataTransfer): string | null {
  const raw = dataTransfer.getData(MULTICODE_COMMIT_DROP_MIME).trim()
  return /^[0-9a-fA-F]{4,64}$/.test(raw) ? raw : null
}

export function setSkillDropData(dataTransfer: DataTransfer, payload: SkillDropPayload): void {
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(MULTICODE_SKILL_DROP_MIME, JSON.stringify(payload))
  // Dropped anywhere that is not a terminal — an editor, a note, a chat field —
  // the id is the only text that means anything on its own.
  dataTransfer.setData('text/plain', payload.skillId)
}

export function hasSkillDropData(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(MULTICODE_SKILL_DROP_MIME)
}

function parseSkillDropPayload(dataTransfer: DataTransfer): SkillDropPayload | null {
  const raw = dataTransfer.getData(MULTICODE_SKILL_DROP_MIME)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<SkillDropPayload>
    if (value.version !== 1) return null
    if (typeof value.skillId !== 'string' || !value.skillId.trim()) return null
    if (value.workspaceId !== null && typeof value.workspaceId !== 'string') return null
    return { version: 1, skillId: value.skillId, workspaceId: value.workspaceId }
  } catch {
    return null
  }
}

export async function pasteDroppedSkillIntoTerminal(input: {
  dataTransfer: DataTransfer
  sessionId: string
  workspaceId: string
  workspaceRoot: string
}): Promise<TerminalDropResult> {
  const payload = parseSkillDropPayload(input.dataTransfer)
  if (!payload) return { ok: false, message: 'No skill was dropped.' }
  if (payload.workspaceId && payload.workspaceId !== input.workspaceId) {
    return { ok: false, message: 'Drop skills into a terminal from the same workspace.' }
  }
  return sendSkillToTerminal({
    skillId: payload.skillId,
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
  })
}

/**
 * Parks a skill's invocation at a terminal's prompt, unsubmitted, with the caret
 * left after a trailing space. The single path behind both of the Skills pane's
 * entry points — the drag onto a terminal and the row's Use action — which is
 * what makes them behave identically.
 *
 * The invocation is rendered for the session it lands on, so a skill dragged out
 * of a pane bound to Claude Code onto a Codex tab arrives in Codex's form. Two
 * declarations decide it and neither is guessed here: the CLI's own manifest
 * supplies the template, and the harness directory supplies whether the skill is
 * there to be named natively. A skill this CLI cannot see falls back to the
 * plain prompt mention every agent can follow.
 *
 * Nothing on this path writes to disk. Attach is the pane's other verb and has
 * its own; a skill missing from the target's harness is never installed behind
 * the user's back to make an invocation work.
 *
 * "Can this CLI see it, and in what form" is asked of `agentCapabilities` — the
 * one resolver — rather than derived here from the workspace-wide inventory.
 * That inventory walks a frozen list of harnesses, so a CLI added by manifest
 * alone was invisible to it and its skills silently fell back to the plain
 * mention even where the manifest declared a native form.
 */
export async function sendSkillToTerminal(input: {
  skillId: string
  sessionId: string
  workspaceRoot: string
}): Promise<TerminalDropResult> {
  const sessions = await window.api.terminalList()
  const session = sessions.find(
    (candidate) => candidate.sessionId === input.sessionId && candidate.processAlive
  )
  if (!session) return { ok: false, message: 'Terminal session is no longer running.' }
  // A shell has no agent to read a skill, and which CLI is running is what
  // decides the form — a session that cannot answer that gets neither.
  if (session.kind !== 'agent' || !session.cli) {
    return { ok: false, message: 'Skills go to an agent, not a plain terminal.' }
  }

  let plugins: PluginRegistryListEntry[]
  let reachable: AgentSkill | undefined
  try {
    const [pluginsResult, capabilities] = await Promise.all([
      window.api.pluginsList(),
      window.api.agentCapabilities({ workspaceRoot: input.workspaceRoot, pluginId: session.cli }),
    ])
    // Either read failing leaves the form of the invocation unknown, and a
    // guessed one is worse than none: a Claude tab silently handed a sentence
    // where `/skill` was expected looks like the skill simply did not work.
    if (!pluginsResult.ok) return { ok: false, message: pluginsResult.message }
    if (!capabilities.ok) return { ok: false, message: capabilities.message }
    plugins = pluginsResult.plugins
    reachable = capabilities.skills.find((candidate) => candidate.id === input.skillId)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Could not read this agent’s skills.',
    }
  }

  const integration = plugins.find((entry) => entry.id === session.cli)?.skillIntegration
  // A CLI that declares it reads no skills is refused rather than handed a
  // sentence it will never act on. A CLI that declares no skill integration at
  // all is a different answer — it gets the plain mention below.
  if (integration?.support === 'unsupported') {
    return { ok: false, message: 'This agent does not read skills.' }
  }

  // The resolver already rendered this CLI's own form for a skill it can see.
  // A skill it cannot see has no native form to offer: the plain mention is what
  // any agent can act on, and naming `/skill` for a directory that is not there
  // would look like the skill simply did not work.
  const invocation = reachable?.invocation ?? plainSkillInvocation(input.skillId)

  // The trailing space is the convention every other prefill follows: the
  // invocation is complete, and the caret sits where arguments go. Nothing is
  // submitted — a bracketed paste is text at the prompt, not a keypress.
  const text = `${invocation} `
  await window.api.terminalWrite(input.sessionId, bracketedPaste(text))
  return { ok: true, text }
}

export async function pasteDroppedFilesIntoTerminal(input: {
  dataTransfer: DataTransfer
  sessionId: string
  workspaceId: string
}): Promise<TerminalDropResult> {
  const payload = parseFileDropPayload(input.dataTransfer)
  if (!payload) return { ok: false, message: 'That drop carried no file.' }
  return sendFileDropToTerminal({
    payload,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
  })
}

// Shared send-to-agent core: drag-drop (above) and the Backlog row context
// menu both route a FileDropPayload to a terminal session through this path.
export async function sendFileDropToTerminal(input: {
  payload: FileDropPayload
  sessionId: string
  workspaceId: string
}): Promise<TerminalDropResult> {
  const { payload } = input
  if (payload.workspaceId && payload.workspaceId !== input.workspaceId) {
    return { ok: false, message: 'Drop files into a terminal from the same workspace.' }
  }

  const sessions = await window.api.terminalList()
  const session = sessions.find(
    (candidate) => candidate.sessionId === input.sessionId && candidate.processAlive
  )
  if (!session) return { ok: false, message: 'Terminal session is no longer running.' }

  // Same gating as the skill invocation, but recorded even when the paste falls
  // back to a plain path (unsupported CLI) — a handoff is a handoff.
  const backlog = backlogItemDropDescriptor(payload, session) ?? undefined

  const skillInvocation = await resolveBacklogSkillInvocation(payload, session)
  if (skillInvocation) {
    await window.api.terminalWrite(input.sessionId, bracketedPaste(skillInvocation))
    return { ok: true, text: skillInvocation, ...(backlog ? { backlog } : {}) }
  }

  const text = formatDroppedPathsForTerminal(payload, session)
  if (!text) return { ok: false, message: 'No valid file path was available to drop.' }

  await window.api.terminalWrite(input.sessionId, bracketedPaste(text))
  return { ok: true, text, ...(backlog ? { backlog } : {}) }
}

// The backlog/ relative path for a single-file drop onto an agent terminal, or
// null. Shared by the skill-invocation gate and the link-recording descriptor.
// Excludes non-agent sessions, worktree agents (they keep plain-path pastes and
// must not fork the object store), multi-file drops, directories, and
// non-backlog paths.
function backlogDropRelativePath(
  payload: FileDropPayload,
  session: TerminalSessionSnapshot,
): string | null {
  if (session.kind !== 'agent') return null
  if (session.executionMode === 'worktree' || session.worktreePath) return null
  if (payload.files.length !== 1) return null
  const [file] = payload.files
  if (file.isDir || !isSafeDroppedPath(file.path)) return null
  return backlogRelativePath(payload.rootPath, file.path)
}

// The Backlog item + agent identity for a drop that hands a single backlog/ file
// to an agent terminal session, for recording the item ↔ agent link. Null
// unless the path qualifies AND the session carries an agent id to link to.
export function backlogItemDropDescriptor(
  payload: FileDropPayload,
  session: TerminalSessionSnapshot,
): BacklogDropDescriptor | null {
  const relativePath = backlogDropRelativePath(payload, session)
  if (!relativePath || !session.agentId) return null
  return { relativePath, agentId: session.agentId, workspaceRoot: payload.rootPath }
}

// A single backlog/ item dropped into a supported agent terminal pastes the
// CLI plugin's declared skill invocation so the agent picks the item up through
// the installed backlog skill (lifecycle updates included) instead of receiving
// a bare path.
export function backlogSkillInvocationForDrop(
  payload: FileDropPayload,
  session: TerminalSessionSnapshot,
  plugins: readonly PluginRegistryListEntry[],
  installedTargets: readonly BuiltinSkillTargetState[]
): string | null {
  if (session.kind !== 'agent') return null
  // Worktree agents would mutate the worktree's copy of the backlog object
  // store, silently forking lifecycle state; they keep plain path pastes.
  if (session.executionMode === 'worktree' || session.worktreePath) return null
  const plugin = session.cli ? plugins.find((entry) => entry.id === session.cli) : undefined
  const integration = plugin?.skillIntegration
  if (!plugin || !integration || integration.support === 'unsupported') return null
  if (payload.files.length !== 1) return null

  const [file] = payload.files
  if (file.isDir || !isSafeDroppedPath(file.path)) return null
  const relativePath = backlogRelativePath(payload.rootPath, file.path)
  if (!relativePath) return null
  if (relativePath.includes("'")) return null
  const template = integration.invocation?.fileDropTemplate
  if (!template) return null
  if (integration.support === 'native' && !hasInstalledNativeSkillTarget(integration.harnessId, plugin.id, installedTargets)) {
    return null
  }

  return renderSkillInvocationTemplate(template, {
    skillId: BACKLOG_SKILL_ID,
    skillName: 'Backlog',
    path: /\s/.test(relativePath) ? `'${relativePath}'` : relativePath,
  })
}

// Backwards-compatible export for older tests/callers. Prefer
// backlogSkillInvocationForDrop for plugin-declared behavior.
//
// The inline manifests below state no install targets on purpose: this path
// reads support, harnessId and invocation only, and a harness directory
// written here would be a second declaration competing with the real one.
export function backlogSlashCommandForDrop(
  payload: FileDropPayload,
  session: TerminalSessionSnapshot,
  installedHarnesses: readonly SkillHarness[]
): string | null {
  const plugins: PluginRegistryListEntry[] = [
    {
      id: 'claude-code',
      displayName: 'Claude Code',
      source: 'bundled',
      version: 1,
      binary: 'claude',
      resumeSession: true,
      sessionIdFromCaller: true,
      skillIntegration: {
        support: 'native',
        harnessId: 'claude',
        installTargets: [],
        invocation: { fileDropTemplate: '/{{skillId}} {{path}}', nativeSlashCommand: true },
      },
    },
    {
      id: 'claude',
      displayName: 'Claude Code',
      source: 'bundled',
      version: 1,
      binary: 'claude',
      resumeSession: true,
      sessionIdFromCaller: true,
      skillIntegration: {
        support: 'native',
        harnessId: 'claude',
        installTargets: [],
        invocation: { fileDropTemplate: '/{{skillId}} {{path}}', nativeSlashCommand: true },
      },
    },
    {
      id: 'codex',
      displayName: 'Codex',
      source: 'bundled',
      version: 1,
      binary: 'codex',
      resumeSession: true,
      sessionIdFromCaller: false,
      skillIntegration: {
        support: 'native',
        harnessId: 'codex',
        installTargets: [],
        invocation: { fileDropTemplate: 'Use ${{skillId}} to work {{path}}.', explicitMention: true },
      },
    },
  ]
  const targets = installedHarnesses.map((harness): BuiltinSkillTargetState => ({
    harness,
    status: 'installed',
    support: 'native',
  }))
  return backlogSkillInvocationForDrop(payload, session, plugins, targets)
}

async function resolveBacklogSkillInvocation(
  payload: FileDropPayload,
  session: TerminalSessionSnapshot
): Promise<string | null> {
  // Cheap shape check first; only ask the skill manager when the drop matches.
  if (!isBacklogSkillDropCandidate(payload, session)) return null

  try {
    const [status, pluginsResult] = await Promise.all([
      window.api.builtinSkillStatus({
        workspaceRoot: payload.rootPath,
        skillId: BACKLOG_SKILL_ID,
      }),
      window.api.pluginsList(),
    ])
    if (!status.ok || !pluginsResult.ok) return null
    return backlogSkillInvocationForDrop(payload, session, pluginsResult.plugins, status.targets)
  } catch {
    return null
  }
}

function isBacklogSkillDropCandidate(payload: FileDropPayload, session: TerminalSessionSnapshot): boolean {
  const relativePath = backlogDropRelativePath(payload, session)
  // The single-quote guard is a skill-invocation concern (the quoted-path
  // template); link recording accepts the path regardless.
  return relativePath !== null && !relativePath.includes("'")
}

function backlogRelativePath(rootPath: string, filePath: string): string | null {
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const file = filePath.replace(/\\/g, '/')
  if (!root) return null
  if (!file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null
  const relativePath = file.slice(root.length + 1)
  if (!/^backlog\/.+/i.test(relativePath)) return null
  return relativePath
}

function parseFileDropPayload(dataTransfer: DataTransfer): FileDropPayload | null {
  const raw = dataTransfer.getData(MULTICODE_FILE_DROP_MIME)
  // Only fall back to native Files when the Multicode MIME entry is entirely
  // absent — a present-but-malformed entry stays a rejection.
  if (!raw) return parseNativeFileDropPayload(dataTransfer)
  return parseFileDropJson(raw)
}

/**
 * The published module-facing parse (mirrored verbatim by @multicode/module-sdk
 * and parity-tested against it): strictly the Multicode MIME entry — no
 * native-Files fallback — returning null on a missing entry, unparseable JSON,
 * an unknown version, or an invalid shape. Never throws.
 */
export function readFileDropPayload(dataTransfer: DataTransfer): FileDropPayload | null {
  const raw = dataTransfer.getData(MULTICODE_FILE_DROP_MIME)
  if (!raw) return null
  return parseFileDropJson(raw)
}

function parseFileDropJson(raw: string): FileDropPayload | null {
  try {
    const value = JSON.parse(raw) as Partial<FileDropPayload>
    if (
      value.version !== 1
      || (value.workspaceId !== null && typeof value.workspaceId !== 'string')
      || typeof value.rootPath !== 'string'
    ) {
      return null
    }
    if (!Array.isArray(value.files)) return null

    // Entries are rebuilt, never passed through: an invalid or non-boolean
    // isDir is skipped (`file.isDir ?` downstream must never see a truthy
    // non-boolean like 'false'), and unknown extra properties are dropped.
    const files: FileDropPayload['files'] = []
    for (const file of value.files) {
      if (
        !file
        || typeof file.path !== 'string'
        || file.path.trim().length === 0
        || typeof file.name !== 'string'
        || (file.isDir !== undefined && typeof file.isDir !== 'boolean')
      ) {
        continue
      }
      files.push({
        path: file.path,
        name: file.name,
        ...(file.isDir === undefined ? {} : { isDir: file.isDir }),
      })
    }

    if (!files.length) return null
    return {
      version: 1,
      workspaceId: value.workspaceId,
      rootPath: value.rootPath,
      files,
    }
  } catch {
    return null
  }
}

function parseNativeFileDropPayload(dataTransfer: DataTransfer): FileDropPayload | null {
  const files = Array.from(dataTransfer.files)
    .map((file) => {
      const path = getNativeFilePath(file)
      return path ? { path, name: file.name } : null
    })
    .filter((file): file is { path: string; name: string } => Boolean(file))

  if (!files.length) return null

  return {
    version: 1,
    workspaceId: null,
    rootPath: '',
    files,
  }
}

function getNativeFilePath(file: File): string | null {
  const path = window.api.getPathForFile(file) || (file as File & { path?: unknown }).path
  return typeof path === 'string' && path.trim() ? path : null
}

export function formatDroppedPathsForTerminal(
  payload: FileDropPayload,
  session: TerminalSessionSnapshot
): string {
  const style = session.pathStyle ?? inferPathStyle(session.cwd ?? payload.rootPath)
  return payload.files
    .map((file) => {
      const relativeRoot = file.isDir ? payload.rootPath : session.cwd
      return formatDroppedPath(file.path, relativeRoot || payload.rootPath, style)
    })
    .filter(Boolean)
    .map((pathValue) => quotePathForTerminal(pathValue, style))
    .join(' ')
}

function formatDroppedPath(
  filePath: string,
  cwd: string,
  style: TerminalPathStyle
): string {
  if (!isSafeDroppedPath(filePath)) return ''
  const relative = getRelativePath(cwd, filePath, style)
  if (relative) return normalizeSeparatorsForStyle(relative, style)
  return normalizeSeparatorsForStyle(toRuntimePath(filePath, style), style)
}

function isSafeDroppedPath(pathValue: string): boolean {
  return !/[\x00-\x1F\x7F]/.test(pathValue)
}

export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

function quotePathForTerminal(pathValue: string, style: TerminalPathStyle): string {
  if (style === 'windows') {
    return `'${pathValue.replace(/'/g, "''")}'`
  }

  return `'${pathValue.replace(/'/g, `'\"'\"'`)}'`
}

function getRelativePath(parentPath: string, childPath: string, style: TerminalPathStyle): string | null {
  const parent = toComparablePath(parentPath, style)
  const child = toComparablePath(childPath, style)
  if (parent === child || !child.startsWith(`${parent}/`)) return null

  const runtimeParent = normalizeComparableShape(toRuntimePath(parentPath, style))
  const runtimeChild = normalizeComparableShape(toRuntimePath(childPath, style))
  return runtimeChild.slice(runtimeParent.length + 1)
}

function toComparablePath(pathValue: string, style: TerminalPathStyle): string {
  const runtimePath = toRuntimePath(pathValue, style)
  const normalized = normalizeComparableShape(runtimePath)
  return style === 'windows' || style === 'wsl'
    ? normalized.toLowerCase()
    : normalized
}

function normalizeComparableShape(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '')
}

function toRuntimePath(pathValue: string, style: TerminalPathStyle): string {
  if (style === 'wsl') return toWslPath(pathValue)
  if (style === 'windows') return toWindowsPath(pathValue)
  return pathValue.replace(/\\/g, '/')
}

function normalizeSeparatorsForStyle(pathValue: string, style: TerminalPathStyle): string {
  return style === 'windows'
    ? pathValue.replace(/\//g, '\\')
    : pathValue.replace(/\\/g, '/')
}

function inferPathStyle(pathValue: string): TerminalPathStyle {
  if (/^[A-Za-z]:[\\/]/.test(pathValue) || /^\\\\/.test(pathValue)) return 'windows'
  if (/^\/mnt\/[A-Za-z]\//.test(pathValue)) return 'wsl'
  return 'posix'
}

function toWslPath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/)
  if (!driveMatch) return normalized

  const [, drive, rest] = driveMatch
  return `/mnt/${drive.toLowerCase()}/${rest}`
}

function toWindowsPath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  const wslMatch = normalized.match(/^\/mnt\/([A-Za-z])\/(.*)$/)
  if (!wslMatch) return pathValue

  const [, drive, rest] = wslMatch
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`
}
