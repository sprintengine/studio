/**
 * The repo task source: the front door the GitHub/Jira `repo-event` automation
 * trigger reads a workspace's imported issues through.
 *
 * These shapes came from the task store of a retired module (removed 2026-09).
 * The repo-event trigger family is live — it has its own editor UI and its own
 * wire config — so the record shapes it needs live here instead, named for what
 * they carry rather than for the store that once produced them.
 *
 * Nothing in the app registers a source today; a capability module supplies one
 * by providing `RepoTaskSourceFrontDoorsToken`. Until one does, the trigger
 * registers and validates as always and reports its integration as missing —
 * the same state a packaged build has always shipped, because the module that
 * once backed it was never registered outside a development build.
 */

import type { RepoEventTrackerProvider } from '../../shared/automations/contracts'

/** The automation integration id the repo-event trigger requires. */
export const REPO_TASK_SOURCE_INTEGRATION_ID = 'module:repo-tasks'

/**
 * The author id an importer stamps on the comment that records an import.
 * The trigger derives a task's "created" event time from that comment, so the
 * id is a guard: a comment written by anyone else cannot forge an import event.
 */
export const REPO_TASK_IMPORT_AUTHOR_ID = 'repo-import'

/** The trackers a repo task can be imported from. */
export type RepoTaskProvider = RepoEventTrackerProvider

export type RepoTaskAuthorType = 'user' | 'agent' | 'system'

export type RepoTaskAuthor = {
  type: RepoTaskAuthorType
  id?: string | null
  name?: string | null
}

export type RepoTaskCommentKind = 'comment' | 'status_change' | 'claim' | 'evidence' | 'import' | 'triage'

export type RepoTaskComment = {
  id: string
  author: RepoTaskAuthor
  kind: RepoTaskCommentKind
  body: string
  createdAt: string
}

/**
 * Where a task came from. `type` is an open string: only `github` and `jira`
 * produce repo events, and every other origin is ignored rather than enumerated
 * here, so a source can add its own kinds without touching this contract.
 */
export type RepoTaskSource = {
  type: string
  externalId?: string | null
  externalKey?: string | null
  externalUrl?: string | null
  externalUpdatedAt?: string | null
}

export type RepoTask = {
  id: string
  identifier: string
  title: string
  state: string
  labels: string[]
  source: RepoTaskSource
  comments: RepoTaskComment[]
  /**
   * When the local record last changed. The trigger deliberately ignores it:
   * a repo event is keyed on the external tracker's own timestamps, so editing
   * a task locally must never look like an upstream change.
   */
  updatedAt?: string
}

export type RepoTaskRecord = {
  task: RepoTask
}

export type RepoTaskReadResult =
  | { ok: true; workspaceRoot: string; tasks: RepoTaskRecord[] }
  | { ok: false; message: string }

export type RepoTaskSourceFrontDoors = {
  readAllTasks(input: { workspaceRoot: string }): Promise<RepoTaskReadResult>
}
