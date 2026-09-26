import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ConversationCheckpointFile, ConversationTurnDiffResult } from '../../../../../shared/conversation-runtime'
import { GhostButton, InlineNotice, Spinner, Tooltip } from '../../ui'
import { FileTreeRow } from '../../ui/FileTree'
import { useConfirmDialog } from '../../ui/ConfirmDialog'
import { InlineDiff } from '../../ui/InlineDiff'
import { deriveEditHunks } from '../../../../../shared/conversation/editHunks'
import { showToast } from '../../../store/toastStore'
import { useConversationLinkContext } from './conversationLinks'
import { useConversationDisclosure } from './conversationViewState'
import { openCheckpointDiffWindow } from '../../auxWindows/openCheckpointDiffWindow'

export type TurnChangeSummary = { files: number; addedLines: number; removedLines: number }
export function hasTurnChanges(available: boolean | undefined, summary: TurnChangeSummary | undefined): boolean {
  return available === true && Boolean(summary && summary.files > 0)
}

export function RevertTurnAction({
  turnSeq,
  running,
  reverted = false,
  className,
}: {
  turnSeq: number
  running: boolean
  reverted?: boolean
  className?: string
}) {
  const context = useConversationLinkContext()
  const dialog = useConfirmDialog()
  const [pending, setPending] = useState(false)
  async function revert() {
    if (!context?.agentId || running || pending) return
    setPending(true)
    const key = { workspaceRoot: context.workspaceRoot, workspaceId: context.workspaceId, agentId: context.agentId }
    try {
      const preview = await window.api.conversationRevertToTurn({ key, turnSeq, undo: reverted })
      if (!preview.ok) throw new Error(preview.message)
      const accepted = await dialog.confirm({
        title: reverted ? 'Undo this revert?' : 'Revert to before this turn?',
        tone: 'danger',
        confirmLabel: reverted ? 'Undo revert' : 'Revert files',
        body: (
          <>
            <p>
              The following files and their staged state will be restored. Your conversation stays in history. A
              recovery checkpoint is kept before reverting.
            </p>
            <ul className="max-h-60 overflow-auto">
              {preview.files.map((file) => (
                <li key={file.path}>
                  {file.path} · +{file.addedLines} −{file.removedLines}
                </li>
              ))}
            </ul>
          </>
        ),
      })
      if (!accepted) return
      const result = await window.api.conversationRevertToTurn({ key, turnSeq, undo: reverted, confirmed: true })
      if (!result.ok) throw new Error(result.message)
      showToast({
        tone: 'good',
        title: reverted ? 'Revert undone' : 'Files reverted. Undo revert can restore the previous state.',
      })
    } catch (error) {
      showToast({
        tone: 'error',
        title: `Could not restore files: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setPending(false)
    }
  }
  return (
    <Tooltip
      content={
        running
          ? 'Stop the running turn before restoring files'
          : reverted
            ? 'Restore the recovery checkpoint'
            : 'Preview the files that will be restored'
      }
    >
      <span className={className}>
        <GhostButton size="inline" disabled={running || pending} onClick={() => void revert()}>
          {pending ? 'Preparing…' : reverted ? 'Undo revert' : 'Revert to before this turn'}
        </GhostButton>
      </span>
    </Tooltip>
  )
}

type ChangeNode = { path: string; name: string; children: ChangeNode[]; file?: ConversationCheckpointFile }
export function changeTree(files: ConversationCheckpointFile[]): ChangeNode[] {
  const roots: ChangeNode[] = []
  for (const file of files) {
    let level = roots
    let path = ''
    for (const [index, name] of file.path.split('/').entries()) {
      path = path ? `${path}/${name}` : name
      let node = level.find((item) => item.path === path)
      if (!node) {
        node = { path, name, children: [] }
        level.push(node)
      }
      if (index === file.path.split('/').length - 1) node.file = file
      level = node.children
    }
  }
  const sort = (nodes: ChangeNode[]) => {
    nodes.sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name))
    for (const node of nodes) sort(node.children)
  }
  sort(roots)
  return roots
}

function ChangeTreeNode({
  node,
  depth,
  parent,
  conversationKey,
  turnSeq,
  selected,
  select,
  prefix,
}: {
  node: ChangeNode
  depth: number
  parent: string
  conversationKey: string
  turnSeq: number
  selected: string
  select: (path: string, file?: ConversationCheckpointFile) => void
  prefix: string
}) {
  const [open, setOpen] = useConversationDisclosure(conversationKey, `files:${turnSeq}:${node.path}`, true)
  return (
    <>
      <FileTreeRow
        id={`${prefix}-${encodeURIComponent(node.path)}`}
        data-change-path={node.path}
        data-change-parent={parent}
        name={node.name}
        isDir={!node.file}
        depth={depth}
        indentSteps={0}
        expanded={open}
        selection={selected === node.path ? 'cursor' : null}
        onToggleExpanded={() => setOpen(!open)}
        onClick={() => {
          select(node.path, node.file)
          if (!node.file) setOpen(!open)
        }}
        badge={
          node.file
            ? `${node.file.status[0].toUpperCase()} +${node.file.addedLines} −${node.file.removedLines}`
            : undefined
        }
        aria-label={
          node.file
            ? `${node.path}, ${node.file.status}, ${node.file.addedLines} added, ${node.file.removedLines} removed`
            : node.path
        }
      />
      {!node.file && open ? (
        <div role="group">
          {node.children.map((child) => (
            <ChangeTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              parent={node.path}
              conversationKey={conversationKey}
              turnSeq={turnSeq}
              selected={selected}
              select={select}
              prefix={prefix}
            />
          ))}
        </div>
      ) : null}
    </>
  )
}

export function ChangedFilesCard({
  turnSeq,
  summary,
  running,
  reverted = false,
  undoTurnSeq,
}: {
  turnSeq: number
  summary: TurnChangeSummary
  running: boolean
  reverted?: boolean
  undoTurnSeq?: number
}) {
  const context = useConversationLinkContext()
  const conversationKey = `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`
  const [open, setOpen] = useConversationDisclosure(conversationKey, `files:${turnSeq}`, false)
  const [files, setFiles] = useState<ConversationCheckpointFile[]>()
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<Extract<ConversationTurnDiffResult, { ok: true }>>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const tree = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  const prefix = useId()
  const nodes = useMemo(() => changeTree(files ?? []), [files])
  useEffect(() => {
    if (!open || !context?.agentId || files) return
    let cancelled = false
    setLoading(true)
    setError(undefined)
    void window.api
      .conversationTurnDiff({
        key: { workspaceRoot: context.workspaceRoot, workspaceId: context.workspaceId, agentId: context.agentId },
        turnSeq,
      })
      .then((result) => {
        if (!cancelled) {
          if (result.ok) setFiles(result.diff.files)
          else setError(result.message)
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(String(failure))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, context, files, turnSeq, retry])
  async function select(path: string, file?: ConversationCheckpointFile) {
    setSelected(path)
    const generation = ++request.current
    setDetail(undefined)
    if (!file || !context?.agentId) return
    setLoading(true)
    setError(undefined)
    try {
      const result = await window.api.conversationTurnDiff({
        key: { workspaceRoot: context.workspaceRoot, workspaceId: context.workspaceId, agentId: context.agentId },
        turnSeq,
        path,
      })
      if (generation !== request.current) return
      if (result.ok) setDetail(result)
      else setError(result.message)
    } catch (failure) {
      if (generation === request.current) setError(String(failure))
    } finally {
      if (generation === request.current) setLoading(false)
    }
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const rows = Array.from(tree.current?.querySelectorAll<HTMLElement>('[data-change-path]') ?? [])
    const index = Math.max(
      0,
      rows.findIndex((row) => row.dataset.changePath === selected),
    )
    const current = rows[index]
    let next = index
    if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    else if (event.key === 'Enter' || event.key === ' ') current?.click()
    else if (event.key === 'ArrowRight') {
      if (current?.getAttribute('aria-expanded') === 'false') current.click()
      else if (current?.hasAttribute('aria-expanded')) next = Math.min(rows.length - 1, index + 1)
    } else if (event.key === 'ArrowLeft') {
      if (current?.getAttribute('aria-expanded') === 'true') current.click()
      else next = rows.findIndex((row) => row.dataset.changePath === current?.dataset.changeParent)
    } else return
    event.preventDefault()
    event.stopPropagation()
    if (rows[next] && (next !== index || !selected)) {
      setSelected(rows[next].dataset.changePath ?? '')
      rows[next].scrollIntoView?.({ block: 'nearest' })
    }
  }
  const edits = detail?.patch ? deriveEditHunks({ patch: detail.patch, path: selected }) : []
  return (
    <section
      className={`mt-3 ${reverted ? 'text-[color:var(--sem-color-text-muted)]' : ''}`}
      aria-label="Turn file changes"
    >
      <GhostButton size="inline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {summary.files} files changed · +{summary.addedLines} −{summary.removedLines}
        {reverted ? ' · Reverted' : ''}
      </GhostButton>
      {open ? (
        <>
          <div
            ref={tree}
            role="tree"
            tabIndex={0}
            aria-label="Files changed by this turn"
            aria-activedescendant={selected ? `${prefix}-${encodeURIComponent(selected)}` : undefined}
            onKeyDown={keyDown}
          >
            {nodes.map((node) => (
              <ChangeTreeNode
                key={node.path}
                node={node}
                depth={0}
                parent=""
                conversationKey={conversationKey}
                turnSeq={turnSeq}
                selected={selected}
                select={(path, file) => void select(path, file)}
                prefix={prefix}
              />
            ))}
          </div>
          {loading ? <Spinner label="Loading turn changes" /> : null}
          {error ? (
            <InlineNotice
              tone="error"
              action={
                <GhostButton
                  size="inline"
                  onClick={() => {
                    setRetry(retry + 1)
                    if (files)
                      void select(
                        selected,
                        files.find((file) => file.path === selected),
                      )
                  }}
                >
                  Retry
                </GhostButton>
              }
            >
              {error}
            </InlineNotice>
          ) : null}
          {edits.map((edit) => (
            <InlineDiff
              key={edit.path}
              edit={edit}
              onOpen={
                context?.agentId
                  ? () =>
                      void openCheckpointDiffWindow({
                        key: {
                          workspaceRoot: context.workspaceRoot,
                          workspaceId: context.workspaceId,
                          agentId: context.agentId!,
                        },
                        turnSeq,
                        path: edit.path,
                      })
                  : undefined
              }
            />
          ))}
          {detail?.diff.files.find((file) => file.path === selected)?.binary ? (
            <p>Binary file changed; no text preview is available.</p>
          ) : null}
          <RevertTurnAction
            turnSeq={reverted ? (undoTurnSeq ?? turnSeq) : turnSeq}
            running={running}
            reverted={reverted}
          />
        </>
      ) : null}
    </section>
  )
}
