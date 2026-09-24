// Part of the IPC contract: diagnostic log entries.
// ../electron-api.ts re-exports everything here.

import type { DiagnosticLevel } from './git'

export type DiagnosticSource =
  | 'agents'
  | 'auth'
  | 'automations'
  | 'cli'
  | 'filesystem'
  | 'marketplace'
  | 'models'
  | 'terminal'
  | 'update'
  | 'voice'
  | 'workspace'

// Serializable deep-focus target for a notification's Open action. Mirrors the
// renderer `NotificationNavigationTarget` (src/renderer/src/types/workspace.ts);
// declared here so a diagnostic's navigation target is an explicit part of the
// logDiagnostic IPC contract rather than an undeclared passthrough.
export type NotificationNavigationTarget = {
  kind: string
  ref: string
}

export type DiagnosticLogInput = {
  level: DiagnosticLevel
  source: DiagnosticSource
  title: string
  message: string
  details?: string
  workspaceId?: string
  workspaceName?: string
  agentId?: string
  sessionId?: string
  navigationTarget?: NotificationNavigationTarget
  /**
   * The Extensions drawer row this news belongs to (`ExtensionsDrawerRowId`:
   * design, plugins, skills), when the emitter
   * knows. Absent, the row is read off `source` (`extensionsRowOfNotification`).
   * A string rather than the row type because this shape is shared with the
   * main process and persists to localStorage; unknown values fall back to the
   * source rule.
   */
  extensionsRow?: string
}

export type DiagnosticLogEntry = DiagnosticLogInput & {
  id: string
  timestamp: string
  logPath?: string
}

export type WorkspaceFolderCheckResult =
  | { ok: true; status: 'ready'; path: string; checkedPath: string; message: string }
  | {
      ok: false
      status: 'missing' | 'inaccessible' | 'timeout'
      path: string
      checkedPath: string
      message: string
      code?: string
    }

// A logo found at the top level of a project's repo. `dataUrl` is the
// sanitized, downscaled image ready to render in an icon slot; `path` and
// `mtimeMs` are what the main process re-checks on the next open so a changed
// or deleted file is picked up without a watcher.
export type ProjectLogo = {
  path: string
  mtimeMs: number
  dataUrl: string
}
