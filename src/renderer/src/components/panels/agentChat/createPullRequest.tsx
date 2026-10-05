import React, { useCallback, useEffect, useId, useState } from 'react'

import type { CreatePullRequestState } from '../../../../../shared/git/pull-request-create'
import type { BranchPullRequest } from '../../../../../shared/git/pull-request'
import { resolveStoreTextGenerationEngine } from '../../../store/generatedWorkspaceTitle'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { Field, GhostButton, PullRequestGlyph, Spinner } from '../../ui'
import { Input, Textarea } from '../../ui/Input'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../../ui/Modal'
import { linkPullRequestToConversation } from '../../workspace/useConversationPullRequests'

// The chat's "Create PR" (owner ruling 2026-10-04), in the same slot at the
// bottom of the chat as "Open PR #123", and never beside it. The slot shows:
//
// - "Open PR #N" while the conversation owns an open (or draft) pull request;
// - "Create PR" when the checkout is ready to propose (`createPullRequestReadiness`:
//   a named branch that is not the default, nothing uncommitted, commits no
//   merged pull request carried, and no open pull request from the branch,
//   whoever opened it);
// - otherwise the conversation's merged pull request, as the sidebar shows it,
//   or nothing.
//
// Pressing it drafts a title and description with the person's own agent CLI
// (Settings → Agents → Text generation), shows them, editable, and creates the
// pull request only on "Create": it is outward-facing, so it is seen before it
// is sent. The app then pushes the branch if its remote is behind and opens
// the pull request itself — `gh pr create` on GitHub, or the forge's own
// prefilled page on the others — and records it as this conversation's, which
// flips the slot to "Open PR #N". Every step says where it is, and a failure
// says why, on the strip.
//
// This computer's checkouts only: a chat on WSL, an SSH machine or a paired
// machine draws no button, because its git and `gh` are not here.

/** Which control the slot draws. */
export type PullRequestSlotChoice = 'open' | 'create' | 'merged' | null

/** The slot's rule, pure (see the header). */
export function pullRequestSlotChoice(
  pullRequests: readonly BranchPullRequest[],
  createReady: boolean,
): PullRequestSlotChoice {
  if (pullRequests.some((pr) => pr.state === 'open')) return 'open'
  if (createReady) return 'create'
  if (pullRequests.some((pr) => pr.state === 'merged')) return 'merged'
  return null
}

/**
 * Whether the checkout is ready to propose, asked of main when the chat opens,
 * when `refreshKey` changes (a turn ended, the branch or its changes moved, a
 * pull request moved) and when the window comes back to the front. Null asks
 * nothing and answers nothing.
 */
export function useCreatePullRequestState(cwd: string | null, refreshKey: string): CreatePullRequestState | null {
  const [state, setState] = useState<CreatePullRequestState | null>(null)
  const ask = useCallback(async () => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!cwd || typeof api?.createPullRequestState !== 'function') {
      setState(null)
      return
    }
    try {
      setState(await api.createPullRequestState(cwd))
    } catch {
      // A shell that cannot answer (the web client has no checkout here) draws no button.
      setState(null)
    }
  }, [cwd])
  useEffect(() => {
    void ask()
  }, [ask, refreshKey])
  useEffect(() => {
    const onFocus = () => void ask()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [ask])
  return state
}

type Progress = { step: 'pushing' | 'creating' | 'recording' } | { step: 'failed'; message: string } | null

const STEP_WORDS: Record<'pushing' | 'creating' | 'recording', string> = {
  pushing: 'Pushing the branch…',
  creating: 'Opening the pull request…',
  recording: 'Opening the pull request…',
}

/**
 * The "Create PR" button, its confirm step, and the progress and failures it
 * says on the strip.
 */
export function CreatePullRequestControl({
  cwd,
  conversation,
  onSettled,
  onHoldChange,
}: {
  cwd: string
  conversation: { workspaceId: string; agentId: string }
  /** The flow ended (created, opened a forge page, or failed): ask again whether the button may show. */
  onSettled: () => void
  /**
   * The control has something on screen of its own: the dialog, a step in
   * progress, or a failure. The slot keeps it while it does, even once the
   * checkout stops reading as ready, which it does the moment the pull
   * request exists: the ask `onSettled` starts would otherwise unmount it
   * with a failure to record it still unread.
   */
  onHoldChange?: (held: boolean) => void
}): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [progress, setProgress] = useState<Progress>(null)
  const held = dialogOpen || progress !== null
  useEffect(() => {
    onHoldChange?.(held)
  }, [held, onHoldChange])
  useEffect(() => () => onHoldChange?.(false), [onHoldChange])

  const create = async (text: { title: string; body: string }) => {
    setDialogOpen(false)
    const api = window.api
    setProgress({ step: 'pushing' })
    const pushed = await api.pushForPullRequest(cwd).catch((error: unknown) => failed(error))
    if (!pushed.ok) {
      setProgress({ step: 'failed', message: pushed.message })
      return
    }
    setProgress({ step: 'creating' })
    const created = await api.createPullRequest({ cwd, ...text }).catch((error: unknown) => failed(error))
    if (!created.ok) {
      setProgress({ step: 'failed', message: created.message })
      return
    }
    if (created.kind === 'page') {
      // The forge opens it from its own page; nothing exists to record yet.
      void api.openExternal?.(created.url)
      setProgress(null)
      onSettled()
      return
    }
    setProgress({ step: 'recording' })
    const recorded = await linkPullRequestToConversation(conversation, created.url, text.title)
    setProgress(recorded.ok ? null : { step: 'failed', message: recorded.message })
    onSettled()
  }

  const busy = progress !== null && progress.step !== 'failed'
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" data-strip-create-pull-request="">
      {progress?.step === 'failed' ? (
        <span
          role="alert"
          className="min-w-0 max-w-64 truncate text-meta text-[color:var(--tone-error)]"
          title={progress.message}
          data-create-pull-request-error=""
        >
          {progress.message}
        </span>
      ) : busy ? (
        <span
          role="status"
          className="inline-flex items-center gap-1.5 whitespace-nowrap text-meta text-[color:var(--text-subtle)]"
        >
          <Spinner size={12} />
          {STEP_WORDS[progress.step]}
        </span>
      ) : null}
      {busy ? null : (
        <GhostButton
          size="xs"
          tone="subtle"
          onClick={() => {
            setProgress(null)
            setDialogOpen(true)
          }}
          aria-label="Create a pull request from this branch"
          className="shrink-0 gap-1.5 whitespace-nowrap"
        >
          <PullRequestGlyph state="open" className="icon-xs" />
          Create PR
        </GhostButton>
      )}
      {dialogOpen ? (
        <CreatePullRequestDialog
          cwd={cwd}
          onCancel={() => setDialogOpen(false)}
          onCreate={(text) => void create(text)}
        />
      ) : null}
    </span>
  )
}

function failed(error: unknown): { ok: false; message: string } {
  return { ok: false, message: error instanceof Error ? error.message : String(error) }
}

/**
 * The confirm step: the drafted title and description, editable, and
 * "Create". Drafting failing is said here, and leaves both fields to write by
 * hand.
 */
function CreatePullRequestDialog({
  cwd,
  onCancel,
  onCreate,
}: {
  cwd: string
  onCancel: () => void
  onCreate: (text: { title: string; body: string }) => void
}): React.JSX.Element {
  const titleId = useId()
  const titleFieldId = useId()
  const bodyFieldId = useId()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [drafting, setDrafting] = useState(true)
  const [draftError, setDraftError] = useState<string | null>(null)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)

  useEffect(() => {
    let alive = true
    const engine = resolveStoreTextGenerationEngine()
    if (!engine) {
      setDrafting(false)
      setDraftError(
        'Text generation is off (Settings → Agents → Text generation), so write the title and description here.',
      )
      return
    }
    void window.api
      .draftPullRequestText({ cwd, engine, ...(cliRuntimes ? { cliRuntimes } : {}) })
      .then((result) => {
        if (!alive) return
        if (result.ok) {
          setTitle((current) => current || result.value.title)
          setBody((current) => current || result.value.body)
        } else {
          setDraftError(`The draft could not be written: ${result.message}`)
        }
      })
      .catch((error: unknown) => {
        if (alive) setDraftError(`The draft could not be written: ${failed(error).message}`)
      })
      .finally(() => {
        if (alive) setDrafting(false)
      })
    return () => {
      alive = false
    }
    // Drafted once per opening; the runtimes only matter at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault()
    if (!title.trim() || drafting) return
    onCreate({ title: title.trim(), body })
  }

  return (
    <Modal open onClose={onCancel} labelledBy={titleId} size="wide">
      <form onSubmit={submit}>
        <ModalHeader title="Create a pull request" titleId={titleId} onClose={onCancel} />
        <ModalBody className="flex flex-col gap-3">
          {drafting ? (
            <p role="status" className="inline-flex items-center gap-2 text-body text-[color:var(--text-muted)]">
              <Spinner size={14} />
              Writing a title and description from the branch’s commits…
            </p>
          ) : null}
          {draftError ? (
            <p role="alert" className="text-body text-[color:var(--tone-error)]">
              {draftError}
            </p>
          ) : null}
          <Field label="Title" htmlFor={titleFieldId}>
            <Input
              id={titleFieldId}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={drafting}
              maxLength={300}
            />
          </Field>
          <Field label="Description" htmlFor={bodyFieldId}>
            <Textarea
              id={bodyFieldId}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              disabled={drafting}
              rows={12}
              className="font-mono"
            />
          </Field>
        </ModalBody>
        <ModalFooter>
          <ModalButton type="button" onClick={onCancel}>
            Cancel
          </ModalButton>
          <ModalButton type="submit" variant="primary" disabled={drafting || !title.trim()}>
            Create
          </ModalButton>
        </ModalFooter>
      </form>
    </Modal>
  )
}
