import { useCallback } from 'react'
import {
  normalizeSprintEngineProjection,
  resolveSprintEngineArtifactEditorPath,
} from '../../../utils/sprintengine'
import { basename, isAbsoluteFilePath, joinFilePath, parentPath } from '../../../utils/paths'
import { focusOrAddFileTab } from '../../../utils/modelRegistry'
import type {
  ArtifactActionState,
  SprintEnginePreviewedArtifact,
  TaskCommentActionState,
  TaskInputActionState,
} from '../sprintEngineInspector'
import type { SprintEngineArtifact } from '../../../types/workspace'

export type { SprintEnginePreviewedArtifact } from '../sprintEngineInspector'

const artifactEditorPathHelpers = {
  parentPath,
  joinFilePath,
  isAbsoluteFilePath,
}

export type SprintEngineArtifactSyncMessage = {
  status: 'idle' | 'syncing' | 'live' | 'error'
  message: string
}

export type SprintEngineRequestChangesDialog = {
  artifact: SprintEngineArtifact
  feedback: string
  submitting: boolean
  error: string | null
}

type WindowApi = {
  approveSprintEngineArtifact: (
    statePath: string,
    artifactId: string,
  ) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>
  requestSprintEngineArtifactChanges: (
    statePath: string,
    artifactId: string,
    feedback: string,
  ) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>
  resolveSprintEngineTaskInput: (
    input: { statePath: string; taskId: string; resolution: string; complete?: boolean },
  ) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>
  commentSprintEngineTask: (
    input: { statePath: string; taskId: string; body: string },
  ) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>
  setSprintEngineTaskStatus: (
    input: { statePath: string; taskId: string; status: string },
  ) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>
  pathExists: (path: string) => Promise<boolean>
  readfile: (path: string) => Promise<string>
}

/**
 * Inputs for {@link useSprintEngineBoardArtifactActions}. The hook stays
 * presentation-free — callers pass state setters, the workspace store
 * mutators, the (already typed) IPC surface, and the helpers it needs to
 * refresh the projection after a mutation succeeds.
 */
export type SprintEngineBoardArtifactActionsInput = {
  workspaceId: string
  statePath: string | null | undefined
  teamName: string | undefined
  setArtifactActions: React.Dispatch<React.SetStateAction<Record<string, ArtifactActionState>>>
  setTaskInputActions: React.Dispatch<React.SetStateAction<Record<string, TaskInputActionState>>>
  setTaskCommentActions: React.Dispatch<React.SetStateAction<Record<string, TaskCommentActionState>>>
  setPreviewedArtifact: React.Dispatch<React.SetStateAction<SprintEnginePreviewedArtifact | null>>
  previewedArtifact: SprintEnginePreviewedArtifact | null
  setRequestChangesDialog: React.Dispatch<
    React.SetStateAction<SprintEngineRequestChangesDialog | null>
  >
  requestChangesDialog: SprintEngineRequestChangesDialog | null
  setSyncState: (state: SprintEngineArtifactSyncMessage) => void
  setSprintEngineState: (workspaceId: string, state: ReturnType<typeof normalizeSprintEngineProjection>) => void
  openFile: (workspaceId: string, path: string, name: string, content: string) => void
  refreshSprintEngineState: () => Promise<void>
  api: WindowApi
}

export type SprintEngineBoardArtifactActions = {
  setArtifactAction: (artifactId: string, state: ArtifactActionState | null) => void
  requireArtifactStatePath: () => string | null
  applySprintEngineProjectionContent: (projectionContent: unknown) => boolean
  openArtifact: (artifact: SprintEngineArtifact) => Promise<void>
  popOutPreviewedArtifact: () => void
  approveArtifact: (artifact: SprintEngineArtifact) => Promise<void>
  /**
   * Open the request-changes dialog for an artifact. `prefillFeedback` seeds
   * the feedback textarea (the annotate sink pre-fills serialized pin blocks;
   * the reviewer can still edit and add framing before submitting). Returns
   * false when the dialog could not open (missing team context).
   */
  requestArtifactChanges: (artifact: SprintEngineArtifact, prefillFeedback?: string) => boolean
  cancelRequestArtifactChangesDialog: () => void
  /** Resolves true only when the change request landed (the dialog closed). */
  submitRequestArtifactChanges: () => Promise<boolean>
  /**
   * Resolve a task's `needs_input` blocker from the inspector composer. The
   * human supervisor's actor identity is attached in main (the MCP `id`); the
   * renderer only supplies the resolution text and whether the resolution also
   * completes the task. Resolves to `true` on success so the composer can clear.
   */
  resolveTaskInput: (taskId: string, resolution: string, complete: boolean) => Promise<boolean>
  /**
   * Post a comment on a task, optionally sending it back for rework. Comment
   * lands via `sprintengine.task.comment`; `reopenForRework` additionally sets
   * the task to `in_progress` (`sprintengine.task.status`). Under the single-owner
   * lifecycle the task is re-bound to the agent that implemented it, and the
   * supervisor re-engages that owner rather than routing it to a rework column.
   * Resolves `true` only when every requested mutation succeeded.
   */
  postTaskComment: (
    taskId: string,
    body: string,
    options: { reopenForRework: boolean },
  ) => Promise<boolean>
}

/**
 * Bundles the Sprint Engine board's authenticated mutation callbacks: artifact
 * open-in-preview / approve / request-changes, the task `needs_input` resolve
 * (send-and-resume / resolve-and-complete), and the projection re-apply path
 * used after each mutation. Artifact behavior is preserved verbatim from the
 * inline panel implementation — the hook only changes where the code lives.
 *
 * The renderer still reads Sprint Engine data from the normalized projection
 * (via the existing `window.api.approveSprintEngineArtifact` /
 * `requestSprintEngineArtifactChanges` IPC contracts) and never parses
 * artifact folders directly.
 */
export function useSprintEngineBoardArtifactActions(
  input: SprintEngineBoardArtifactActionsInput,
): SprintEngineBoardArtifactActions {
  const {
    workspaceId,
    statePath,
    teamName,
    setArtifactActions,
    setTaskInputActions,
    setTaskCommentActions,
    setPreviewedArtifact,
    previewedArtifact,
    setRequestChangesDialog,
    requestChangesDialog,
    setSyncState,
    setSprintEngineState,
    openFile,
    refreshSprintEngineState,
    api,
  } = input

  const setArtifactAction = useCallback(
    (artifactId: string, state: ArtifactActionState | null) => {
      setArtifactActions((current) => {
        const next = { ...current }
        if (state) {
          next[artifactId] = state
        } else {
          delete next[artifactId]
        }
        return next
      })
    },
    [setArtifactActions],
  )

  const setTaskInputAction = useCallback(
    (taskId: string, state: TaskInputActionState | null) => {
      setTaskInputActions((current) => {
        const next = { ...current }
        if (state) {
          next[taskId] = state
        } else {
          delete next[taskId]
        }
        return next
      })
    },
    [setTaskInputActions],
  )

  const setTaskCommentAction = useCallback(
    (taskId: string, state: TaskCommentActionState | null) => {
      setTaskCommentActions((current) => {
        const next = { ...current }
        if (state) {
          next[taskId] = state
        } else {
          delete next[taskId]
        }
        return next
      })
    },
    [setTaskCommentActions],
  )

  const requireArtifactStatePath = useCallback((): string | null => {
    if (!statePath) {
      setSyncState({
        status: 'error',
        message: 'This sprint workspace is missing its selected team context.',
      })
      return null
    }
    return statePath
  }, [statePath, setSyncState])

  const applySprintEngineProjectionContent = useCallback(
    (projectionContent: unknown): boolean => {
      if (typeof projectionContent !== 'string') return false
      try {
        const projection = JSON.parse(projectionContent) as unknown
        const parsed = normalizeSprintEngineProjection(projection, teamName)
        if (!parsed) return false
        setSprintEngineState(workspaceId, parsed)
        setSyncState({
          status: 'live',
          message: `Refreshed ${parsed.tasks.length} tasks from projection.json`,
        })
        return true
      } catch {
        return false
      }
    },
    [teamName, workspaceId, setSprintEngineState, setSyncState],
  )

  const applyMutationResultProjection = useCallback(
    async (result: { ok: true; data: unknown } | { ok: false; message: string }): Promise<void> => {
      if (!result.ok) return
      const projectionContent = (result.data as { projectionContent?: unknown } | undefined)
        ?.projectionContent
      const applied = applySprintEngineProjectionContent(projectionContent)
      if (!applied) await refreshSprintEngineState()
    },
    [applySprintEngineProjectionContent, refreshSprintEngineState],
  )

  const openArtifact = useCallback(
    async (artifact: SprintEngineArtifact) => {
      const ensuredStatePath = requireArtifactStatePath()
      if (!ensuredStatePath) return

      setArtifactAction(artifact.id, { kind: 'open', status: 'pending', message: 'Opening...' })
      const artifactPath = resolveSprintEngineArtifactEditorPath(
        ensuredStatePath,
        artifact.path,
        artifactEditorPathHelpers,
      )
      const fileName = basename(artifactPath) || artifact.path
      try {
        const exists = await api.pathExists(artifactPath)
        if (!exists) {
          // Expected, not exceptional: the record can exist before its file does
          // (a gate seeded at run creation, an agent that registered ahead of
          // writing). Say that in the user's words and keep the path behind the
          // details disclosure rather than pasting an absolute path into the row.
          setArtifactAction(artifact.id, {
            kind: 'open',
            status: 'error',
            message: `${fileName} has not been written yet.`,
            hint: 'The agent registered this artifact before creating the file. It opens once the file lands.',
            detail: artifactPath,
          })
          return
        }
        const content = await api.readfile(artifactPath)
        setPreviewedArtifact({
          id: artifact.id,
          path: artifactPath,
          relativePath: artifact.path,
          name: basename(artifactPath) || artifact.title || artifact.id,
          content,
        })
        setArtifactAction(artifact.id, {
          kind: 'open',
          status: 'success',
          message: 'Opened in preview.',
        })
      } catch (error) {
        // A per-artifact open failure (e.g. an unreadable file) is an inline
        // action error, not a board-sync failure — route it only to this
        // artifact's actionState so it does not flip the board banner to
        // "Refresh failed". The raw string rides along as `detail`.
        const raw = error instanceof Error ? error.message : String(error)
        setArtifactAction(artifact.id, {
          kind: 'open',
          status: 'error',
          message: `${fileName} could not be opened.`,
          hint: 'The file may have moved since the agent wrote it. Refresh the board, then try again.',
          detail: raw,
        })
      }
    },
    [requireArtifactStatePath, setArtifactAction, setPreviewedArtifact, api],
  )

  // Pop the previewed artifact out into a real flexlayout file-editor tab.
  // Useful when the user wants the full editor experience (split view, code
  // language features) instead of the inline preview.
  const popOutPreviewedArtifact = useCallback(() => {
    if (!previewedArtifact) return
    openFile(workspaceId, previewedArtifact.path, previewedArtifact.name, previewedArtifact.content)
    focusOrAddFileTab(workspaceId, previewedArtifact.path, previewedArtifact.name)
    setPreviewedArtifact(null)
  }, [previewedArtifact, openFile, workspaceId, setPreviewedArtifact])

  // Manual artifact review actions are authenticated Sprint Engine MCP/core
  // mutations: the renderer hands intent to main IPC, Sprint Engine performs
  // the state transition, and the returned projection drives the UI. No
  // approval text is typed into the producer terminal.
  const approveArtifact = useCallback(
    async (artifact: SprintEngineArtifact) => {
      const ensuredStatePath = requireArtifactStatePath()
      if (!ensuredStatePath) return

      setArtifactAction(artifact.id, {
        kind: 'approve',
        status: 'pending',
        message: 'Approving artifact...',
      })
      try {
        const result = await api.approveSprintEngineArtifact(ensuredStatePath, artifact.id)
        if (!result.ok) {
          setArtifactAction(artifact.id, {
            kind: 'approve',
            status: 'error',
            message: result.message || 'The sprint rejected the approval.',
          })
          return
        }
        await applyMutationResultProjection(result)
        setArtifactAction(artifact.id, {
          kind: 'approve',
          status: 'success',
          message: 'Approved through the sprint.',
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to approve artifact.'
        setArtifactAction(artifact.id, { kind: 'approve', status: 'error', message })
      }
    },
    [requireArtifactStatePath, setArtifactAction, applyMutationResultProjection, api],
  )

  const requestArtifactChanges = useCallback(
    (artifact: SprintEngineArtifact, prefillFeedback?: string): boolean => {
      if (!requireArtifactStatePath()) return false
      setRequestChangesDialog({
        artifact,
        feedback: prefillFeedback ?? '',
        submitting: false,
        error: null,
      })
      return true
    },
    [requireArtifactStatePath, setRequestChangesDialog],
  )

  const cancelRequestArtifactChangesDialog = useCallback(() => {
    setRequestChangesDialog((current) => (current?.submitting ? current : null))
  }, [setRequestChangesDialog])

  const submitRequestArtifactChanges = useCallback(async (): Promise<boolean> => {
    const dialogState = requestChangesDialog
    if (!dialogState || dialogState.submitting) return false
    const feedback = dialogState.feedback.trim()
    if (!feedback) {
      setRequestChangesDialog((current) =>
        current ? { ...current, error: 'Feedback is required to request changes.' } : current,
      )
      return false
    }
    const ensuredStatePath = requireArtifactStatePath()
    if (!ensuredStatePath) {
      setRequestChangesDialog((current) =>
        current
          ? { ...current, error: 'This sprint workspace is missing its selected team context.' }
          : current,
      )
      return false
    }

    const { artifact } = dialogState
    setRequestChangesDialog((current) => (current ? { ...current, submitting: true, error: null } : current))
    setArtifactAction(artifact.id, {
      kind: 'requestChanges',
      status: 'pending',
      message: 'Requesting changes...',
    })
    try {
      const result = await api.requestSprintEngineArtifactChanges(ensuredStatePath, artifact.id, feedback)
      if (!result.ok) {
        const message = result.message || 'The sprint rejected the change request.'
        setRequestChangesDialog((current) =>
          current ? { ...current, submitting: false, error: message } : current,
        )
        setArtifactAction(artifact.id, {
          kind: 'requestChanges',
          status: 'error',
          message,
        })
        return false
      }
      await applyMutationResultProjection(result)
      setArtifactAction(artifact.id, {
        kind: 'requestChanges',
        status: 'success',
        message: 'Changes requested through the sprint.',
      })
      setRequestChangesDialog(null)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to request changes.'
      setRequestChangesDialog((current) =>
        current ? { ...current, submitting: false, error: message } : current,
      )
      setArtifactAction(artifact.id, {
        kind: 'requestChanges',
        status: 'error',
        message,
      })
      return false
    }
  }, [
    requestChangesDialog,
    setRequestChangesDialog,
    requireArtifactStatePath,
    setArtifactAction,
    applyMutationResultProjection,
    api,
  ])

  // Resolving a needs_input blocker is a Sprint Engine task mutation, not an
  // artifact one, but it rides the same authenticated MCP → projection-refresh
  // pipeline as the artifact actions above, so it lives here rather than in a
  // parallel hook that would duplicate the statePath guard and projection apply.
  const resolveTaskInput = useCallback(
    async (taskId: string, resolution: string, complete: boolean): Promise<boolean> => {
      const trimmed = resolution.trim()
      if (!trimmed) {
        setTaskInputAction(taskId, {
          status: 'error',
          message: 'A response is required to resume the agent.',
        })
        return false
      }
      const ensuredStatePath = requireArtifactStatePath()
      if (!ensuredStatePath) {
        setTaskInputAction(taskId, {
          status: 'error',
          message: 'This sprint workspace is missing its selected team context.',
        })
        return false
      }

      setTaskInputAction(taskId, {
        status: 'pending',
        message: complete ? 'Resolving and completing…' : 'Sending response…',
      })
      try {
        const result = await api.resolveSprintEngineTaskInput({
          statePath: ensuredStatePath,
          taskId,
          resolution: trimmed,
          complete,
        })
        if (!result.ok) {
          setTaskInputAction(taskId, {
            status: 'error',
            message: result.message || 'The sprint rejected the response.',
          })
          return false
        }
        await applyMutationResultProjection(result)
        setTaskInputAction(taskId, {
          status: 'success',
          message: complete ? 'Resolved and marked complete.' : 'Response sent — agent resuming.',
        })
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to send response.'
        setTaskInputAction(taskId, { status: 'error', message })
        return false
      }
    },
    [requireArtifactStatePath, setTaskInputAction, applyMutationResultProjection, api],
  )

  // Add a comment to any task, optionally sending it back for rework. Both are
  // authenticated Sprint Engine mutations (`task.comment`, then `task.status
  // in_progress` to reopen it under its owner); the supervisor's actor id is
  // attached in main. When rework is requested and only the comment lands, the
  // comment is still reflected and the partial failure is surfaced rather than hidden.
  const postTaskComment = useCallback(
    async (
      taskId: string,
      body: string,
      options: { reopenForRework: boolean },
    ): Promise<boolean> => {
      const trimmed = body.trim()
      if (!trimmed) {
        setTaskCommentAction(taskId, { status: 'error', message: 'A comment is required.' })
        return false
      }
      const ensuredStatePath = requireArtifactStatePath()
      if (!ensuredStatePath) {
        setTaskCommentAction(taskId, {
          status: 'error',
          message: 'This sprint workspace is missing its selected team context.',
        })
        return false
      }

      setTaskCommentAction(taskId, {
        status: 'pending',
        message: options.reopenForRework ? 'Posting comment and sending back…' : 'Posting comment…',
      })
      try {
        const commentResult = await api.commentSprintEngineTask({
          statePath: ensuredStatePath,
          taskId,
          body: trimmed,
        })
        if (!commentResult.ok) {
          setTaskCommentAction(taskId, {
            status: 'error',
            message: commentResult.message || 'The sprint rejected the comment.',
          })
          return false
        }

        if (options.reopenForRework) {
          const statusResult = await api.setSprintEngineTaskStatus({
            statePath: ensuredStatePath,
            taskId,
            status: 'in_progress',
          })
          if (!statusResult.ok) {
            // The comment landed; reflect it and report the partial failure.
            await applyMutationResultProjection(commentResult)
            setTaskCommentAction(taskId, {
              status: 'error',
              message: `Comment posted, but sending back for rework failed: ${
                statusResult.message || 'The sprint rejected the status change.'
              }`,
            })
            return false
          }
          await applyMutationResultProjection(statusResult)
          setTaskCommentAction(taskId, {
            status: 'success',
            message: 'Comment posted — sent back for rework.',
          })
          return true
        }

        await applyMutationResultProjection(commentResult)
        setTaskCommentAction(taskId, { status: 'success', message: 'Comment added.' })
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to post comment.'
        setTaskCommentAction(taskId, { status: 'error', message })
        return false
      }
    },
    [requireArtifactStatePath, setTaskCommentAction, applyMutationResultProjection, api],
  )

  return {
    setArtifactAction,
    requireArtifactStatePath,
    applySprintEngineProjectionContent,
    openArtifact,
    popOutPreviewedArtifact,
    approveArtifact,
    requestArtifactChanges,
    cancelRequestArtifactChangesDialog,
    submitRequestArtifactChanges,
    resolveTaskInput,
    postTaskComment,
  }
}
