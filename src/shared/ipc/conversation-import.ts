// Part of the IPC contract: bringing the conversations a person had in an
// agent CLI's own terminal into the app as chats.
// ../electron-api.ts re-exports everything here.

/**
 * The CLIs whose saved sessions the import reads. Each one keeps every session
 * it ran as a transcript on disk, under the CLI's own home, and resumes one by
 * its id; a chat made from one carries that id, so its next message continues
 * the same session rather than starting over.
 */
export type ConversationImportSource = 'claude-code' | 'codex'

/** One session a CLI saved, as the picker lists it. */
export type ConversationImportSession = {
  source: ConversationImportSource
  /** The CLI's own id for the session: what it resumes by. */
  sessionId: string
  title: string
  /** The folder the session ran in, which the chat works in too. */
  folderPath: string
  startedAt: number
  /** When the session was last active: its newest record's time, else its file's. */
  updatedAt: number
  /** A chat here already carries this session. */
  imported: boolean
}

/** The sessions that ran in one folder, newest first. */
export type ConversationImportFolder = {
  folderPath: string
  /** The folder's own name, for the row. */
  name: string
  lastActiveAt: number
  sessions: ConversationImportSession[]
}

export type ConversationImportScanResult =
  | {
      ok: true
      /** Newest first. Only folders that still exist on this machine. */
      folders: ConversationImportFolder[]
      /** The CLIs whose home was found here, whether or not it held a session. */
      sources: ConversationImportSource[]
    }
  | { ok: false; message: string }

export type ConversationImportInput = {
  sessions: Array<{ source: ConversationImportSource; sessionId: string }>
}

export type ConversationImportResult =
  | {
      ok: true
      /** One chat per session it made, in the order asked. */
      imported: Array<{ source: ConversationImportSource; sessionId: string; workspaceId: string; agentId: string }>
      /** Sessions a chat already carried, left as they were. */
      skipped: number
      failed: Array<{ source: ConversationImportSource; sessionId: string; title: string; message: string }>
    }
  | { ok: false; message: string }
