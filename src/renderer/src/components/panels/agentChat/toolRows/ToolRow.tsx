import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationToolDetail, ConversationJsonValue } from '../../../../../../shared/conversation-runtime'
import {
  presentToolItem,
  type PresentableTool,
  type ToolPresentation,
} from '../../../../../../shared/conversation/presentation'
import { labelCommand } from '../../../../../../shared/conversation/commandLabel'
import { parseAnsi } from '../../../../../../shared/conversation/ansi'
import { Checkbox, GhostButton, InlineNotice, RowButton, Spinner } from '../../../ui'
import { CodeBlock } from '../../../ui/CodeBlock'
import { ConversationFileLink, conversationText, useConversationLinkContext } from '../conversationLinks'
import { useConversationDisclosure } from '../conversationViewState'
import type { TranscriptToolEntry } from '../conversationProjection'
import { AnsiOutput } from '../AnsiOutput'
import { deriveEditHunks } from '../../../../../../shared/conversation/editHunks'
import { InlineDiff } from '../../../ui/InlineDiff'
import { openCheckpointDiffWindow } from '../../../auxWindows/openCheckpointDiffWindow'
import { useLiveRowMotion } from '../liveVisibility'
import { formatClockTime, LiveElapsed } from '../liveElapsed'
import { useConversationTransport } from '../conversationTransport'
import { resolveTerminalFileReferencePath } from '../../../../utils/terminalFileLinks'
import { treeRelativePath } from '../../../../utils/fileTreeEntries'
import { copyToClipboardWithToast } from '../../../../utils/copyToClipboardWithToast'
import { ChevronRightGlyph, ToolKindGlyph } from './ToolKindGlyph'

export function toolPresentationInput(tool: TranscriptToolEntry): PresentableTool {
  return {
    kind: tool.toolKind,
    name: tool.name,
    input: tool.input,
    status: tool.status === 'running' ? 'running' : (tool.outputStatus ?? 'ok'),
    exitCode: tool.exitCode,
    summary: tool.summary,
    subagentType: tool.subagentType,
  }
}
function pretty(value: ConversationJsonValue | undefined): string {
  return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2)
}
function object(value: ConversationJsonValue | undefined): Record<string, ConversationJsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

// Where the step's own words sit when a row opens: one contained, height-capped
// panel, the same for every kind of step, so a command's output, a search's
// matches and a tool's reply all read as "what this step produced" and never as
// loose text spilling into the transcript around it. It scrolls inside itself
// rather than pushing the conversation down.
function ToolPanel({
  copyText,
  mono = true,
  children,
}: {
  copyText?: string
  mono?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="group/tool-panel relative rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]">
      {copyText ? (
        <GhostButton
          size="xs"
          aria-label="Copy output"
          className="absolute right-1 top-1 opacity-0 group-hover/tool-panel:opacity-100 focus-visible:opacity-100"
          onClick={() => void copyToClipboardWithToast(copyText)}
        >
          Copy
        </GhostButton>
      ) : null}
      <div
        className={`max-h-72 overflow-auto px-3 py-2 text-meta leading-relaxed text-[color:var(--text-default)] ${
          mono ? 'whitespace-pre-wrap break-words font-mono' : ''
        }`}
      >
        {children}
      </div>
    </div>
  )
}

// The image formats main will hand back as a data URL (filesystem-image.ts).
const PREVIEWABLE_IMAGE = /\.(apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/iu
export function isPreviewableImagePath(path: string): boolean {
  return PREVIEWABLE_IMAGE.test(path.trim())
}

export function ToolBody({ tool, detail }: { tool: TranscriptToolEntry; detail?: ConversationToolDetail }) {
  const input = object(detail?.input ?? tool.input)
  const output = pretty(detail?.output ?? tool.output)
  const presentation = presentToolItem(toolPresentationInput(tool))
  const kind = presentation.icon
  // Parsing megabytes of fetched output on every render (each streamed token
  // re-renders the turn) stalls the chat; it only changes with the output.
  const ansi = useMemo(() => (kind === 'command' ? parseAnsi(output) : null), [kind, output])
  const path = String(input.path ?? input.file_path ?? '')
  const status = detail?.status ?? tool.outputStatus
  if (status === 'declined' || status === 'stopped')
    return (
      <p className="text-[color:var(--text-muted)]">
        {status === 'declined' ? 'Tool request declined' : 'Tool stopped'}
      </p>
    )
  if (kind === 'command') {
    const command = String(input.command ?? input.cmd ?? tool.summary ?? '')
    const exitCode = detail?.exitCode ?? tool.exitCode
    return (
      <ToolPanel copyText={output ? `$ ${command}\n${output}` : `$ ${command}`}>
        <div className="text-[color:var(--text-strong)]">$ {command}</div>
        {output ? (
          <div className="mt-1.5 text-[color:var(--text-muted)]">
            <AnsiOutput lines={ansi ?? []} />
          </div>
        ) : null}
        {exitCode !== undefined ? <div className="mt-1.5 text-[color:var(--text-subtle)]">exit {exitCode}</div> : null}
      </ToolPanel>
    )
  }
  if (kind === 'file_read')
    return isPreviewableImagePath(path) ? <ImagePreview path={path} /> : <ReadOutput output={output} path={path} />
  if (kind === 'file_edit' || kind === 'file_write')
    return <EditBody input={detail?.input ?? tool.input} toolUseId={tool.id} />
  if (kind === 'todo') {
    const todos = Array.isArray(input.todos) ? input.todos : []
    return (
      <ToolPanel mono={false}>
        <ul className="flex flex-col gap-1">
          {todos.map((value, index) => {
            const todo = object(value)
            return (
              <li key={index}>
                <Checkbox
                  readOnly
                  checked={todo.status === 'completed'}
                  ariaLabel={String(todo.content ?? todo.description ?? 'Task')}
                />{' '}
                {String(todo.content ?? todo.description ?? '')}
              </li>
            )
          })}
        </ul>
      </ToolPanel>
    )
  }
  if (kind === 'search' || kind === 'list' || kind === 'web') {
    // The row's label already carries the query; the panel repeats it only when
    // the label had to shorten it.
    const query = String(input.query ?? input.pattern ?? input.url ?? input.path ?? '')
    return (
      <ToolPanel copyText={output || undefined}>
        {query && !presentation.title.includes(query) ? (
          <div className="mb-1.5 text-[color:var(--text-strong)]">{conversationText(query)}</div>
        ) : null}
        <div className="text-[color:var(--text-muted)]">{output ? conversationText(output) : 'No results'}</div>
      </ToolPanel>
    )
  }
  const request = pretty(detail?.input ?? tool.input)
  return (
    <ToolPanel copyText={output || request || undefined}>
      {request ? <div className="text-[color:var(--text-subtle)]">{request}</div> : null}
      {output ? <div className={`text-[color:var(--text-default)] ${request ? 'mt-2' : ''}`}>{output}</div> : null}
    </ToolPanel>
  )
}

// An image the agent looked at is shown, not described: the picture is what it
// read, and a path to a screenshot says nothing about what was on it. Only a
// file on this machine can be shown — a remote conversation's path names a file
// over there.
function ImagePreview({ path }: { path: string }) {
  const context = useConversationLinkContext()
  const localFiles = useConversationTransport().capabilities.localFiles
  const resolved = localFiles
    ? resolveTerminalFileReferencePath(path, { executionRoot: context?.cwd, workspaceRoot: context?.workspaceRoot })
    : null
  const [image, setImage] = useState<{ path: string; src?: string; failed?: boolean }>()
  useEffect(() => {
    if (!resolved) return
    let cancelled = false
    window.api.readImageDataUrl(resolved).then(
      (src) => {
        if (!cancelled) setImage({ path: resolved, src })
      },
      () => {
        if (!cancelled) setImage({ path: resolved, failed: true })
      },
    )
    return () => {
      cancelled = true
    }
  }, [resolved])
  if (!resolved) return <p className="text-[color:var(--text-muted)]">This image is on another machine.</p>
  const current = image?.path === resolved ? image : undefined
  if (current?.failed)
    // Screenshots in particular are often read from a temporary folder the
    // system empties minutes later, so a missing file is the expected case.
    return <p className="text-[color:var(--text-muted)]">This image is no longer available to preview.</p>
  if (!current?.src) return <Spinner label="Loading image" />
  return (
    <img
      src={current.src}
      alt={path.split(/[\\/]/).at(-1) ?? path}
      className="block max-h-64 max-w-full rounded-sm border border-[color:var(--border-subtle)] object-contain"
    />
  )
}

function EditBody({ input, toolUseId }: { input: ConversationJsonValue | undefined; toolUseId: string }) {
  const context = useConversationLinkContext()
  // The diff window reads this machine's checkpoints; a remote edit has none here.
  const openable = useConversationTransport().capabilities.localFiles
  const edits = useMemo(() => deriveEditHunks(input), [input])
  return (
    <>
      {edits.map((edit, index) => (
        <div key={index}>
          <ConversationFileLink token={edit.path} source="inlineCode" variant="chip" />
          <InlineDiff
            edit={edit}
            onOpen={
              context?.agentId && openable
                ? () =>
                    void openCheckpointDiffWindow({
                      key: {
                        workspaceId: context.workspaceId,
                        workspaceRoot: context.workspaceRoot,
                        agentId: context.agentId!,
                      },
                      toolUseId,
                      editIndex: index,
                      path: edit.path,
                    })
                : undefined
            }
          />
        </div>
      ))}
    </>
  )
}

function ReadOutput({ output, path }: { output: string; path: string }) {
  const context = useConversationLinkContext()
  const [all, setAll] = useState(false)
  const lines = output.split('\n')
  return (
    <>
      <CodeBlock
        code={all ? output : lines.slice(0, 40).join('\n')}
        language={path.split('.').at(-1)}
        filename={path ? displayToolPath(path, context) : undefined}
      />
      {lines.length > 40 ? (
        <GhostButton size="inline" onClick={() => setAll(!all)}>
          {all ? 'Show less' : 'Show all'}
        </GhostButton>
      ) : null}
    </>
  )
}

// Fetched full output, kept by call id: the virtualized timeline unmounts a row
// scrolled out of view, and scrolling back must not lose (or refetch) it. The
// cap is on size, not count: one detail can be megabytes, and twenty of those
// would pin a hundred of them in the renderer for the session.
const MAX_CACHED_DETAIL_BYTES = 16 * 1024 * 1024
const detailCache = new Map<string, { detail: ConversationToolDetail; bytes: number }>()
let cachedDetailBytes = 0
// What the detail holds in memory: its strings are UTF-16, two bytes a unit.
function detailBytes(detail: ConversationToolDetail): number {
  return (pretty(detail.output).length + pretty(detail.input).length) * 2
}
function cachedDetail(key: string): ConversationToolDetail | undefined {
  const entry = detailCache.get(key)
  if (entry) {
    detailCache.delete(key)
    detailCache.set(key, entry)
  }
  return entry?.detail
}
function forgetDetail(key: string): void {
  const entry = detailCache.get(key)
  if (!entry) return
  detailCache.delete(key)
  cachedDetailBytes -= entry.bytes
}
function cacheDetail(key: string, detail: ConversationToolDetail): void {
  forgetDetail(key)
  const bytes = detailBytes(detail)
  if (bytes > MAX_CACHED_DETAIL_BYTES) return
  detailCache.set(key, { detail, bytes })
  cachedDetailBytes += bytes
  while (cachedDetailBytes > MAX_CACHED_DETAIL_BYTES) forgetDetail(detailCache.keys().next().value!)
}

// The ink a step's glyph wears: accent and pulsing while it runs, error when it
// failed, and otherwise the quietest ink there is. Settled steps are the
// conversation's working-out, not what it says — a column of them should read
// as texture under the prose until one of them needs the eye.
export function toolGlyphInk(tone: ToolPresentation['tone'] | 'running'): string {
  if (tone === 'running') return 'text-[color:var(--tone-accent)] status-dot-pulse'
  if (tone === 'error') return 'text-[color:var(--tone-error)]'
  return 'text-[color:var(--text-disabled)] group-hover/tool-row:text-[color:var(--text-subtle)]'
}

// A path as the row shows it: relative to where the agent runs, or to the
// workspace, when it is inside either. An absolute path out of a temp folder is
// most of a row's width spent on directories nobody needs to read.
export function displayToolPath(path: string, context: { cwd?: string; workspaceRoot?: string } | null): string {
  for (const root of [context?.cwd, context?.workspaceRoot]) {
    const relative = root ? treeRelativePath(root, path) : null
    if (relative) return relative
  }
  return path
}

// A click anywhere on the row's ground opens it, not only on the label — the
// chevron sits at the far end. Clicks that land on a real control inside the
// row (the label's own button, the file link) are that control's.
function toggleFromRowGround(event: React.MouseEvent<HTMLElement>, toggle: () => void) {
  if (event.target instanceof Element && event.target.closest('button, a')) return
  toggle()
}

export function ToolRow({ tool }: { tool: TranscriptToolEntry }) {
  const context = useConversationLinkContext()
  const transport = useConversationTransport()
  const key = `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`
  const detailKey = `${transport.kind === 'remote' ? `remote:${transport.machineName}:` : ''}${key}:${tool.id}`
  const [open, setOpen] = useConversationDisclosure(key, `tool:${tool.id}`, false)
  const [detail, setDetail] = useState<ConversationToolDetail | undefined>(() => cachedDetail(detailKey))
  // Output fetched while the tool was still running is a snapshot of a moving
  // target: it is shown but never cached, and can be fetched again.
  const [partial, setPartial] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const presentation = presentToolItem(toolPresentationInput(tool), (command) => labelCommand(command).label)
  const running = tool.status === 'running'
  const tone = running ? 'running' : presentation.tone
  const settledAt = running ? undefined : (tool.completedAt ?? tool.startedAt)
  const rowRef = useRef<HTMLDivElement>(null)
  useLiveRowMotion(rowRef, running)
  async function fetchDetail() {
    if (!context?.agentId) {
      setError('Tool detail is unavailable for this conversation')
      return
    }
    const stillRunning = running
    setLoading(true)
    setError(undefined)
    try {
      const result = await transport.toolDetail({
        workspaceRoot: context.workspaceRoot,
        workspaceId: context.workspaceId,
        agentId: context.agentId,
        toolUseId: tool.id,
      })
      if (result.ok) {
        if (stillRunning) forgetDetail(detailKey)
        else cacheDetail(detailKey, result.detail)
        setPartial(stillRunning)
        setDetail(result.detail)
      } else setError(result.message)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load tool output')
    } finally {
      setLoading(false)
    }
  }
  return (
    <div ref={rowRef} data-tool-kind={presentation.icon}>
      <div
        className="group/tool-row flex min-w-0 cursor-pointer items-center gap-1 rounded-sm pr-1.5 transition-colors hover:bg-[color:var(--bg-hover)]"
        onClick={(event) => toggleFromRowGround(event, () => setOpen(!open))}
      >
        {/* Sized to its label rather than stretched, so the path sits right
            beside what the step did instead of across the row from it. */}
        <div className="flex min-w-0 max-w-fit shrink">
          <RowButton density="flush" className="min-w-0 text-meta" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span data-tone={tone === 'error' ? 'error' : undefined} className={`flex shrink-0 ${toolGlyphInk(tone)}`}>
              <ToolKindGlyph kind={presentation.icon} />
            </span>
            <span
              className={`min-w-0 truncate ${running ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-subtle)] group-hover/tool-row:text-[color:var(--text-muted)]'}`}
            >
              {presentation.title}
            </span>
            {running ? <span className="sr-only">running</span> : null}
            {tone === 'error' ? <span className="sr-only">failed</span> : null}
          </RowButton>
        </div>
        {presentation.subtitle ? (
          <span className="min-w-0 shrink-[2] truncate text-meta text-[color:var(--text-disabled)] group-hover/tool-row:text-[color:var(--text-subtle)]">
            {presentation.subtitle.startsWith('exit ') ? (
              presentation.subtitle
            ) : (
              <ConversationFileLink
                token={presentation.subtitle}
                source="inlineCode"
                ink="quiet"
                label={displayToolPath(presentation.subtitle, context)}
              />
            )}
          </span>
        ) : null}
        <span className="min-w-2 flex-1" />
        {running && tool.startedAt !== undefined ? (
          <span className="shrink-0 text-micro tabular-nums text-[color:var(--text-subtle)]">
            <LiveElapsed startedAt={tool.startedAt} />
          </span>
        ) : settledAt !== undefined ? (
          <span className="shrink-0 whitespace-nowrap text-micro tabular-nums text-[color:var(--text-subtle)] opacity-0 group-hover/tool-row:opacity-100">
            {formatClockTime(settledAt)}
          </span>
        ) : null}
        <ChevronRightGlyph
          className={`icon-xs shrink-0 text-[color:var(--text-disabled)] transition-transform group-hover/tool-row:text-[color:var(--text-subtle)] ${open ? 'rotate-90' : ''}`}
        />
      </div>
      {open ? (
        <div className="mb-1.5 ml-6 mt-1 flex flex-col items-start gap-1.5 text-meta [&>*]:w-full">
          <ToolBody tool={tool} detail={detail} />
          {detail?.clipped ? (
            <InlineNotice tone="warn">
              Output exceeded the stored detail limit; the beginning and end are shown.
            </InlineNotice>
          ) : null}
          {loading ? <Spinner label="Loading tool output" /> : null}
          {error ? (
            <InlineNotice
              tone="error"
              action={
                <GhostButton size="inline" onClick={() => void fetchDetail()}>
                  Retry
                </GhostButton>
              }
            >
              {error}
            </InlineNotice>
          ) : null}
          {!detail && !loading && (tool.truncated || tool.inputTruncated) ? (
            <GhostButton size="inline" onClick={() => void fetchDetail()}>
              Show full output
            </GhostButton>
          ) : null}
          {detail && partial && !loading ? (
            <GhostButton size="inline" onClick={() => void fetchDetail()}>
              {running ? 'Refresh output' : 'Show final output'}
            </GhostButton>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
