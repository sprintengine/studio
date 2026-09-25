import { isImageFile } from '../../utils/files'

export type ExternalFileKind = 'text' | 'image'

export type ExternalFileTab = {
  path: string
  name: string
  workspaceId: string
  /** The folder the window's tree shows while this tab is active; empty when the opener knew none. */
  rootPath: string
  kind: ExternalFileKind
}

type ExternalTextBuffer = {
  kind: 'text'
  value: string
  saved: string
  loading: boolean
  error: string | null
}

type ExternalImageBuffer = {
  kind: 'image'
  dataUrl: string | null
  loading: boolean
  error: string | null
}

export type ExternalFileBuffer = ExternalTextBuffer | ExternalImageBuffer

export type ExternalFileLoaderApi = {
  readfile(path: string): Promise<string>
  readImageDataUrl(path: string): Promise<string>
}

function classifyExternalFile(path: string, name: string): ExternalFileKind {
  return isImageFile(path || name) ? 'image' : 'text'
}

export function createExternalFileTab(input: {
  path: string
  name: string
  workspaceId: string
  rootPath?: string
}): ExternalFileTab {
  return {
    ...input,
    rootPath: input.rootPath ?? '',
    kind: classifyExternalFile(input.path, input.name),
  }
}

export function createExternalFileLoadingBuffer(kind: ExternalFileKind): ExternalFileBuffer {
  if (kind === 'image') {
    return { kind, dataUrl: null, loading: true, error: null }
  }
  return { kind, value: '', saved: '', loading: true, error: null }
}

export function isExternalFileBufferDirty(buffer: ExternalFileBuffer | undefined): boolean {
  return Boolean(buffer?.kind === 'text' && buffer.value !== buffer.saved)
}

export async function loadExternalFileBuffer(
  path: string,
  kind: ExternalFileKind,
  api: ExternalFileLoaderApi,
): Promise<ExternalFileBuffer> {
  try {
    if (kind === 'image') {
      const dataUrl = await api.readImageDataUrl(path)
      return { kind, dataUrl, loading: false, error: null }
    }

    const content = await api.readfile(path)
    return { kind, value: content, saved: content, loading: false, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (kind === 'image') {
      return { kind, dataUrl: null, loading: false, error: message }
    }
    return { kind, value: '', saved: '', loading: false, error: message }
  }
}
