type EditorBufferListener = () => void

const buffers = new Map<string, string>()
const listeners = new Map<string, Set<EditorBufferListener>>()

function bufferKey(workspaceId: string, path: string): string {
  return `${workspaceId}\u0000${path}`
}

function emit(workspaceId: string, path: string): void {
  listeners.get(bufferKey(workspaceId, path))?.forEach((listener) => listener())
}

function isPathOrChild(path: string, parentPath: string): boolean {
  if (path === parentPath) return true
  const separator = parentPath.includes('\\') && !parentPath.includes('/') ? '\\' : '/'
  return path.startsWith(`${parentPath}${separator}`)
}

export function getEditorBuffer(workspaceId: string, path: string, fallback = ''): string {
  return buffers.get(bufferKey(workspaceId, path)) ?? fallback
}

export function hasEditorBuffer(workspaceId: string, path: string): boolean {
  return buffers.has(bufferKey(workspaceId, path))
}

export function setEditorBuffer(workspaceId: string, path: string, content: string): void {
  const key = bufferKey(workspaceId, path)
  if (buffers.get(key) === content) return
  buffers.set(key, content)
  emit(workspaceId, path)
}

export function deleteEditorBuffer(workspaceId: string, path: string): void {
  const key = bufferKey(workspaceId, path)
  if (!buffers.delete(key)) return
  emit(workspaceId, path)
}

export function remapEditorBuffers(workspaceId: string, fromPath: string, toPath: string): void {
  const separator = fromPath.includes('\\') && !fromPath.includes('/') ? '\\' : '/'
  const fromPrefix = `${fromPath}${separator}`

  for (const [key, content] of [...buffers.entries()]) {
    const [bufferWorkspaceId, path] = key.split('\u0000')
    if (bufferWorkspaceId !== workspaceId || (!path || (path !== fromPath && !path.startsWith(fromPrefix)))) {
      continue
    }

    const suffix = path === fromPath ? '' : path.slice(fromPath.length)
    const nextPath = `${toPath}${suffix}`
    buffers.delete(key)
    buffers.set(bufferKey(workspaceId, nextPath), content)
    emit(workspaceId, path)
    emit(workspaceId, nextPath)
  }
}

export function removeEditorBuffersForPath(workspaceId: string, path: string): void {
  for (const key of [...buffers.keys()]) {
    const [bufferWorkspaceId, bufferPath] = key.split('\u0000')
    if (bufferWorkspaceId !== workspaceId || !bufferPath || !isPathOrChild(bufferPath, path)) continue
    buffers.delete(key)
    emit(workspaceId, bufferPath)
  }
}

export function subscribeEditorBuffer(
  workspaceId: string,
  path: string,
  listener: EditorBufferListener
): () => void {
  const key = bufferKey(workspaceId, path)
  const bucket = listeners.get(key) ?? new Set<EditorBufferListener>()
  bucket.add(listener)
  listeners.set(key, bucket)

  return () => {
    bucket.delete(listener)
    if (bucket.size === 0) listeners.delete(key)
  }
}
