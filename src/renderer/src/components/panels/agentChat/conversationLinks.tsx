import React, { createContext, useContext, useMemo, useRef, useState } from 'react'
import { classifyLinkToken, type LinkTokenContext } from '../../../../../shared/links/classifyLinkToken'
import { ChipButton, Tooltip } from '../../ui'
import { FileTypeGlyph } from '../../ui/FileTypeGlyph'
import { TerminalLinkMenu } from '../../terminal/TerminalLinkMenu'
import { openFileSurface } from '../../../utils/openFileSurface'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { availableFolderOpenTargets, resolveFolderOpenPrimary } from '../../workspace/openInEditorTargets'
import { resolveTerminalFileReferencePath } from '../../../utils/terminalFileLinks'
import { showToast } from '../../../store/toastStore'
import { CodeBlock } from '../../ui/CodeBlock'
import { StreamingMarkdown } from './StreamingMarkdown'
import { renderMarkdown } from '../../../utils/markdown'
import { FOCUS_RING_CLASS } from '../../ui/tokens'

export type ConversationLinkContext = { workspaceId: string; cwd: string; workspaceRoot: string; agentId?: string }
const LinkContext = createContext<ConversationLinkContext | null>(null)
export function ConversationLinkProvider({
  children,
  ...value
}: ConversationLinkContext & { children: React.ReactNode }) {
  const { workspaceId, cwd, workspaceRoot, agentId } = value
  const stable = useMemo(
    () => ({ workspaceId, cwd, workspaceRoot, agentId }),
    [workspaceId, cwd, workspaceRoot, agentId],
  )
  return <LinkContext.Provider value={stable}>{children}</LinkContext.Provider>
}
export function useConversationLinkContext() {
  return useContext(LinkContext)
}

export const ConversationFileLink = React.memo(function ConversationFileLink({
  token,
  source = 'text',
}: {
  token: string
  source?: LinkTokenContext['source']
}) {
  const context = useContext(LinkContext)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const target = classifyLinkToken(token, {
    source,
    cwd: context?.cwd,
    platform: typeof window === 'undefined' ? 'darwin' : (window.api?.platform ?? 'darwin'),
  })
  if (!target) return <>{token}</>
  if (target.type === 'url') {
    const href = /^[a-z]+:/i.test(target.href) ? target.href : `https://${target.href}`
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={`underline text-[color:var(--sem-color-accent-primary)] ${FOCUS_RING_CLASS}`}
      >
        {token}
      </a>
    )
  }
  const resolved = resolveTerminalFileReferencePath(target.path, {
    executionRoot: context?.cwd,
    workspaceRoot: context?.workspaceRoot,
  })
  const label = target.path.split(/[\\/]/).slice(-2).join('/') + (target.line ? `:${target.line}` : '')
  const report = (message: string) => showToast({ tone: 'error', title: message })
  async function open(external: boolean) {
    if (!context || !resolved || target?.type !== 'file') return
    try {
      const stat = await window.api.statPath(resolved)
      if (!stat.isFile) {
        report(`File not found: ${target.path}`)
        return
      }
      const name = resolved.split(/[\\/]/).at(-1) ?? resolved
      if (external) {
        const available = availableFolderOpenTargets(await window.api.listFolderOpenTargets()).filter(
          (id) => id !== 'finder',
        )
        const editor = resolveFolderOpenPrimary(
          available,
          useWorkspaceStore.getState().appSettings.lastFolderOpenTarget,
        )
        if (!editor) {
          report('No external editor is available')
          return
        }
        const result = await window.api.openFolderInTarget({ target: editor, path: resolved })
        if (!result.ok) report(result.message)
      } else
        openFileSurface({
          workspaceId: context.workspaceId,
          path: resolved,
          name,
          lineNumber: target.line,
          column: target.col,
          rootPath: context.cwd,
        })
    } catch {
      report(`File not found: ${target.path}`)
    }
  }
  return (
    <>
      <Tooltip content={token}>
        <ChipButton
          tone="neutral"
          variant="outline"
          aria-label={`Open ${token}`}
          onClick={(event) => void open(event.metaKey || event.ctrlKey)}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu({ x: event.clientX, y: event.clientY })
          }}
        >
          <FileTypeGlyph name={target.path} className="icon-xs" />
          <span>{label}</span>
        </ChipButton>
      </Tooltip>
      {menu && context && resolved ? (
        <TerminalLinkMenu
          workspaceId={context.workspaceId}
          target={{ kind: 'file', resolvedPath: resolved, isDirectory: false, workspaceRoot: context.workspaceRoot }}
          x={menu.x}
          y={menu.y}
          line={target.line}
          column={target.col}
          onClose={() => setMenu(null)}
          onError={report}
        />
      ) : null}
    </>
  )
})

export function splitProseLinkToken(token: string): { prefix: string; body: string; suffix: string } {
  const prefix = /^[([{"']*/u.exec(token)?.[0] ?? ''
  const start = prefix.length
  let end = token.length
  while (end > start) {
    const char = token[end - 1]
    if (/[.,;:!?"']/u.test(char)) {
      end--
      continue
    }
    const opener = char === ')' ? '(' : char === ']' ? '[' : char === '}' ? '{' : undefined
    if (!opener) break
    const body = token.slice(start, end)
    if (body.split(char).length <= body.split(opener).length) break
    end--
  }
  return { prefix, body: token.slice(start, end), suffix: token.slice(end) }
}

export function conversationText(text: string, source: 'text' | 'inlineCode' = 'text'): React.ReactNode {
  if (source === 'inlineCode') return <ConversationFileLink token={text} source={source} />
  return text.split(/(\s+)/).map((token, index) => {
    if (!/\S/.test(token)) return token
    const { prefix, body, suffix } = splitProseLinkToken(token)
    return (
      <React.Fragment key={index}>
        {prefix}
        <ConversationFileLink token={body} source={source} />
        {suffix}
      </React.Fragment>
    )
  })
}

const renderLink = (href: string) => <ConversationFileLink token={href} source="href" />
export function ConversationMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const streamed = useRef(streaming)
  if (streaming) streamed.current = true
  const options = useMemo(
    () => ({ codeBlock: CodeBlock, streaming, renderText: conversationText, renderLink }),
    [streaming],
  )
  return streamed.current ? <StreamingMarkdown source={text} options={options} /> : <>{renderMarkdown(text, options)}</>
}
