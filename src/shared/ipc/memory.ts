// Part of the IPC contract: the memory graph and its activity feed.
// ../electron-api.ts re-exports everything here.

export type MemoryGraphNodeKind = 'markdown' | 'image' | 'text' | 'asset'

export type MemoryGraphNode = {
  id: string
  path: string
  relativePath: string
  name: string
  kind: MemoryGraphNodeKind
  extension: string
  sizeBytes: number
  degree: number
  inboundDegree: number
  group: string
  title?: string
  type?: string
  tags?: string[]
  related?: string[]
}

export type MemoryGraphEdge = {
  id: string
  source: string
  target: string
  sourcePath: string
  targetPath: string
}

export type MemoryUnresolvedLink = {
  sourcePath: string
  href: string
  resolvedRelativePath: string | null
  reason: 'missing' | 'outside-root'
}

export type MemoryRootStatus =
  | { ok: true; rootPath: string; relativeRoot: string }
  | {
      ok: false
      status: 'missing-workspace' | 'invalid-relative-path' | 'missing-memory-root' | 'inaccessible'
      relativeRoot: string | null
      message: string
    }

export type MemoryGraphIndexResult =
  | {
      ok: true
      rootPath: string
      relativeRoot: string
      nodes: MemoryGraphNode[]
      edges: MemoryGraphEdge[]
      groups: string[]
      unresolvedLinks: MemoryUnresolvedLink[]
      indexedAt: number
    }
  | Extract<MemoryRootStatus, { ok: false }>

export type MemoryPreviewResult =
  | { ok: true; node: MemoryGraphNode; previewKind: 'markdown' | 'text'; content: string }
  | { ok: true; node: MemoryGraphNode; previewKind: 'image'; dataUrl: string }
  | { ok: true; node: MemoryGraphNode; previewKind: 'unsupported'; message: string }
  | { ok: false; message: string }

export type MemoryActivityEvent = {
  workspaceRoot: string
  sessionId: string
  nodeId: string
  prevNodeId: string | null
  tool: string
  ts: number
  synapseCount: number
}

export type MemoryActivitySynapse = {
  src: string
  dst: string
  count: number
  lastTs: number
}

export type MemoryActivityStatus = {
  workspaceRoot: string | null
  isInstalled: boolean
  isWatching: boolean
  sessionsRecorded: number
  totalEvents: number
  eventsToday: number
  lastEventAt: number | null
}

export type MemoryActivityInstallResult =
  { ok: true; settingsPath: string; hookScriptPath: string } | { ok: false; message: string }

export type MemoryActivityUninstallResult = { ok: true } | { ok: false; message: string }

export type MemoryActivitySynapsesPayload = {
  workspaceRoot: string
  synapses: MemoryActivitySynapse[]
}
