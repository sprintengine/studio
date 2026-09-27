// Part of the IPC contract: the workspace backup the renderer writes and reads.
// ../electron-api.ts re-exports everything here.

export type WorkspaceBackupPayload = {
  version: number
  writtenAt: string
  data: unknown
}

export type WorkspaceBackupReadResult =
  | { ok: true; payload: WorkspaceBackupPayload }
  | { ok: false; reason: 'missing' | 'unreadable' | 'parse_error'; message?: string }
