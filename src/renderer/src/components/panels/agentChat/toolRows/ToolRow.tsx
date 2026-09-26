import { useMemo, useRef, useState } from 'react'
import type { ConversationToolDetail, ConversationJsonValue } from '../../../../../../shared/conversation-runtime'
import { presentToolItem, type PresentableTool } from '../../../../../../shared/conversation/presentation'
import { labelCommand } from '../../../../../../shared/conversation/commandLabel'
import { parseAnsi } from '../../../../../../shared/conversation/ansi'
import { Checkbox, GhostButton, InlineNotice, RowButton, Spinner, StatusDot } from '../../../ui'
import { CodeBlock } from '../../../ui/CodeBlock'
import { ConversationFileLink, conversationText, useConversationLinkContext } from '../conversationLinks'
import { useConversationDisclosure } from '../conversationViewState'
import type { TranscriptToolEntry } from '../conversationProjection'
import { AnsiOutput } from '../AnsiOutput'
import { deriveEditHunks } from '../../../../../../shared/conversation/editHunks'
import { InlineDiff } from '../../../ui/InlineDiff'
import { openCheckpointDiffWindow } from '../../../auxWindows/openCheckpointDiffWindow'
import { useLiveRowMotion } from '../liveVisibility'

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

export function ToolBody({ tool, detail }: { tool: TranscriptToolEntry; detail?: ConversationToolDetail }) {
  const input = object(detail?.input ?? tool.input)
  const output = pretty(detail?.output ?? tool.output)
  const kind = presentToolItem(toolPresentationInput(tool)).icon
  const path = String(input.path ?? input.file_path ?? '')
  const status = detail?.status ?? tool.outputStatus
  if (status === 'declined' || status === 'stopped')
    return <p>{status === 'declined' ? 'Tool request declined' : 'Tool stopped'}</p>
  if (kind === 'command')
    return (
      <>
        <pre className="whitespace-pre-wrap font-mono">
          $ {String(input.command ?? input.cmd ?? tool.summary ?? '')}
        </pre>
        <AnsiOutput lines={parseAnsi(output)} />
        {(detail?.exitCode ?? tool.exitCode) !== undefined ? <p>exit {detail?.exitCode ?? tool.exitCode}</p> : null}
      </>
    )
  if (kind === 'file_read')
    return (
      <>
        <ConversationFileLink token={path} source="inlineCode" />
        <ReadOutput output={output} path={path} />
      </>
    )
  if (kind === 'file_edit' || kind === 'file_write')
    return <EditBody input={detail?.input ?? tool.input} toolUseId={tool.id} />
  if (kind === 'todo') {
    const todos = Array.isArray(input.todos) ? input.todos : []
    return (
      <ul>
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
    )
  }
  if (kind === 'search' || kind === 'list' || kind === 'web')
    return (
      <>
        <p>{conversationText(String(input.query ?? input.pattern ?? input.url ?? input.path ?? ''))}</p>
        <pre className="whitespace-pre-wrap font-mono">{conversationText(output)}</pre>
      </>
    )
  return (
    <>
      <CodeBlock code={pretty(detail?.input ?? tool.input)} language="json" />
      <pre className="whitespace-pre-wrap font-mono">{output}</pre>
    </>
  )
}

function EditBody({ input, toolUseId }: { input: ConversationJsonValue | undefined; toolUseId: string }) {
  const context = useConversationLinkContext()
  const edits = useMemo(() => deriveEditHunks(input), [input])
  return (
    <>
      {edits.map((edit, index) => (
        <div key={index}>
          <ConversationFileLink token={edit.path} source="inlineCode" />
          <InlineDiff
            edit={edit}
            onOpen={
              context?.agentId
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
  const [all, setAll] = useState(false)
  const lines = output.split('\n')
  return (
    <>
      <CodeBlock code={all ? output : lines.slice(0, 40).join('\n')} language={path.split('.').at(-1)} />
      {lines.length > 40 ? (
        <GhostButton size="inline" onClick={() => setAll(!all)}>
          {all ? 'Show less' : 'Show all'}
        </GhostButton>
      ) : null}
    </>
  )
}

export function ToolRow({ tool }: { tool: TranscriptToolEntry }) {
  const context = useConversationLinkContext()
  const key = `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`
  const [open, setOpen] = useConversationDisclosure(key, `tool:${tool.id}`, false)
  const [detail, setDetail] = useState<ConversationToolDetail>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [fullHeight, setFullHeight] = useState(false)
  const presentation = presentToolItem(toolPresentationInput(tool), (command) => labelCommand(command).label)
  const running = tool.status === 'running'
  const rowRef = useRef<HTMLDivElement>(null)
  useLiveRowMotion(rowRef, running)
  async function fetchDetail() {
    if (!context?.agentId) {
      setError('Tool detail is unavailable for this conversation')
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const result = await window.api.conversationToolDetail({
        workspaceRoot: context.workspaceRoot,
        workspaceId: context.workspaceId,
        agentId: context.agentId,
        toolUseId: tool.id,
      })
      if (result.ok) {
        setDetail(result.detail)
        setFullHeight(true)
      } else setError(result.message)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load tool output')
    } finally {
      setLoading(false)
    }
  }
  return (
    <div ref={rowRef} data-tool-kind={presentation.icon}>
      <RowButton density="row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? '⌄' : '›'}</span>
        <StatusDot tone={running ? 'accent' : presentation.tone === 'error' ? 'error' : 'neutral'} pulse={running} />
        <span className="min-w-0 flex-1 truncate">{presentation.title}</span>
        {presentation.subtitle ? (
          <span className="truncate text-meta text-[color:var(--sem-color-text-muted)]">{presentation.subtitle}</span>
        ) : null}
        {running ? <span className="sr-only">running</span> : null}
      </RowButton>
      {open ? (
        <div className={`ml-2 px-3 py-2 text-meta ${fullHeight ? '' : 'max-h-80 overflow-auto'}`}>
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
        </div>
      ) : null}
    </div>
  )
}
