// Part of the IPC contract: file watching, stat, and file and content search.
// ../electron-api.ts re-exports everything here.

export interface FileWatchEvent {
  /** `rename` when anything in the burst was created, deleted or renamed. */
  eventType: string
  /** The first path in `paths`, or null when none is known. */
  path: string | null
  /**
   * Every distinct root-relative path that changed inside one coalescing
   * window. Empty with `overflow` set when the OS gave no name or the burst was
   * too large to list: the consumer should re-read.
   */
  paths?: string[]
  overflow?: boolean
}

export type FileSystemStat = {
  isFile: boolean
  isDirectory: boolean
  sizeBytes: number
  modifiedAt: string
  modifiedAtMs: number
}

export type FileSearchEntry = {
  name: string
  path: string
  parentPath: string
  isDir: false
}

export type FileSearchResult =
  | {
      ok: true
      results: FileSearchEntry[]
      truncated: boolean
      engine: 'ripgrep'
      elapsedMs: number
      resultCount: number
    }
  | {
      ok: false
      message: string
      engine: 'ripgrep' | null
    }

export type ContentSearchEntry = {
  name: string
  path: string
  parentPath: string
  lineNumber: number
  column: number
  lineText: string
  matchText: string
}

export type ContentSearchResult =
  | {
      ok: true
      results: ContentSearchEntry[]
      truncated: boolean
      engine: 'ripgrep'
      elapsedMs: number
      resultCount: number
    }
  | {
      ok: false
      message: string
      engine: 'ripgrep' | null
    }
