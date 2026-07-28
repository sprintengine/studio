import type { BuiltinSkillTargetState, SkillHarness } from '../../../shared/electron-api'
import type { PluginRegistryListEntry } from '../../../shared/plugin-manifest'
import { hasInstalledNativeSkillTarget, renderSkillInvocationTemplate } from './skillInvocation'

export const MULTICODE_FILE_DROP_MIME = 'application/x-multicode-file-drop'
export const MULTICODE_COMMIT_DROP_MIME = 'application/x-multicode-commit-drop'

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

export async function pasteDroppedFilesIntoTerminal(input: {
  dataTransfer: DataTransfer
  sessionId: string
  workspaceId: string
}): Promise<TerminalDropResult> {
  const payload = parseFileDropPayload(input.dataTransfer)
  if (!payload) return { ok: false, message: 'No Multicode file was dropped.' }
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
        restartRequired: true,
        installTargetCount: 1,
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
        restartRequired: true,
        installTargetCount: 1,
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
        restartRequired: true,
        installTargetCount: 1,
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
