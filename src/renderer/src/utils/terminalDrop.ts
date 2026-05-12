export const MULTICODE_FILE_DROP_MIME = 'application/x-multicode-file-drop'

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

type TerminalDropResult =
  | { ok: true; text: string }
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

export async function pasteDroppedFilesIntoTerminal(input: {
  dataTransfer: DataTransfer
  sessionId: string
  workspaceId: string
}): Promise<TerminalDropResult> {
  const payload = parseFileDropPayload(input.dataTransfer)
  if (!payload) return { ok: false, message: 'No Multicode file was dropped.' }
  if (payload.workspaceId && payload.workspaceId !== input.workspaceId) {
    return { ok: false, message: 'Drop files into a terminal from the same workspace.' }
  }

  const sessions = await window.api.terminalList()
  const session = sessions.find(
    (candidate) => candidate.sessionId === input.sessionId && candidate.processAlive
  )
  if (!session) return { ok: false, message: 'Terminal session is no longer running.' }

  const text = formatDroppedPathsForTerminal(payload, session)
  if (!text) return { ok: false, message: 'No valid file path was available to drop.' }

  await window.api.terminalWrite(input.sessionId, bracketedPaste(text))
  return { ok: true, text }
}

function parseFileDropPayload(dataTransfer: DataTransfer): FileDropPayload | null {
  const raw = dataTransfer.getData(MULTICODE_FILE_DROP_MIME)
  if (!raw) return parseNativeFileDropPayload(dataTransfer)

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

    const files = value.files
      .filter((file): file is { path: string; name: string; isDir?: boolean } => (
        Boolean(file)
        && typeof file.path === 'string'
        && file.path.trim().length > 0
        && typeof file.name === 'string'
      ))

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

function bracketedPaste(text: string): string {
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
