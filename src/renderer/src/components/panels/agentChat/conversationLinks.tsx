import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { classifyLinkToken, type LinkTokenContext } from '../../../../../shared/links/classifyLinkToken'
import { ChipButton, LinkButton, Tooltip } from '../../ui'
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
import { useConversationTransport } from './conversationTransport'

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

// What each resolved path turned out to be on this disk, asked once per path
// for the life of the window: a transcript repeats the same few paths, and a
// row re-mounting under the virtual list must not re-ask.
const pathKinds = new Map<string, 'file' | 'other'>()

// A path in prose or inline code is a link only when it is a FILE that exists
// here. Before the disk has answered, a path whose last segment has an
// extension reads as one (nearly always right, and it keeps the text from
// changing under the reader); one without — `/Users/dev/project` — reads as text,
// because it is far more often a folder. The answer then settles it either way.
function useExistingFile(resolved: string | null | undefined, path: string | null): boolean {
  const guess = (): boolean => {
    const known = resolved ? pathKinds.get(resolved) : undefined
    if (known) return known === 'file'
    return /\.[A-Za-z0-9]+$/u.test((resolved ?? path ?? '').split(/[\\/]/).at(-1) ?? '')
  }
  const [isFile, setIsFile] = useState(guess)
  useEffect(() => {
    if (!resolved) return
    const known = pathKinds.get(resolved)
    if (known) {
      setIsFile(known === 'file')
      return
    }
    if (typeof window.api?.statPath !== 'function') return
    let cancelled = false
    void window.api
      .statPath(resolved)
      .then((stat) => (stat.isFile ? 'file' : 'other'))
      .catch(() => 'other' as const)
      .then((kind) => {
        pathKinds.set(resolved, kind)
        if (!cancelled) setIsFile(kind === 'file')
      })
    return () => {
      cancelled = true
    }
  }, [resolved])
  return isFile
}

export const ConversationFileLink = React.memo(function ConversationFileLink({
  token,
  source = 'text',
  label: givenLabel,
  variant = 'inline',
}: {
  token: string
  source?: LinkTokenContext['source']
  // What a markdown link says (`[the docs](…)`); shown in place of the target.
  label?: React.ReactNode
  /**
   * `inline` (the default) is a path inside prose or inline code: the text
   * itself, at the text's own size and line height — never a boxed chip
   * mid-sentence, never shortened. `chip` is a file standing as an object in
   * its own right: one the person attached to a message, or a tool row's
   * subject. Either is a link only when it names a file that exists here.
   */
  variant?: 'inline' | 'chip'
}) {
  const context = useContext(LinkContext)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // A path from a conversation on another machine names a file over there;
  // resolving it here could open a same-named local file.
  const localFiles = useConversationTransport().capabilities.localFiles
  const target = classifyLinkToken(token, {
    source,
    cwd: context?.cwd,
    platform: typeof window === 'undefined' ? 'darwin' : (window.api?.platform ?? 'darwin'),
  })
  const resolved =
    target?.type === 'file'
      ? resolveTerminalFileReferencePath(target.path, {
          executionRoot: context?.cwd,
          workspaceRoot: context?.workspaceRoot,
        })
      : null
  const existingFile = useExistingFile(
    target?.type === 'file' && localFiles ? resolved : null,
    target?.type === 'file' ? target.path : null,
  )
  if (!target || (target.type === 'file' && !localFiles)) return <>{givenLabel ?? token}</>
  if (target.type === 'url') {
    const href = /^[a-z]+:/i.test(target.href) ? target.href : `https://${target.href}`
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={`underline text-[color:var(--sem-color-accent-primary)] ${FOCUS_RING_CLASS}`}
      >
        {givenLabel ?? token}
      </a>
    )
  }
  // A folder, or a path that is not on this disk, is text — in a sentence, and
  // as a tool row's subject alike. Only a file gets a link, and only a file
  // gets a file's glyph.
  if (!existingFile) return <>{givenLabel ?? token}</>
  const label = target.path.split(/[\\/]/).slice(-2).join('/') + (target.line ? `:${target.line}` : '')
  const report = (message: string) => showToast({ tone: 'error', title: message })
  async function open(external: boolean) {
    if (!context || !resolved || target?.type !== 'file') return
    try {
      const stat = await window.api.statPath(resolved)
      if (!stat.isFile) {
        pathKinds.set(resolved, 'other')
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
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY })
  }
  return (
    <>
      {variant === 'inline' ? (
        // The kit's inline link at the surrounding text's size: inside a
        // `<code>` it keeps the code's mono face and box, inside prose the
        // prose's, and it sits on the line's baseline without growing it.
        <LinkButton
          ink="accent"
          underline="hover"
          size="inherit"
          aria-label={`Open ${token}`}
          title={resolved ?? token}
          onClick={(event) => void open(event.metaKey || event.ctrlKey)}
          onContextMenu={onContextMenu}
        >
          {givenLabel ?? token}
        </LinkButton>
      ) : (
        <Tooltip content={token}>
          <ChipButton
            tone="neutral"
            variant="outline"
            aria-label={`Open ${token}`}
            onClick={(event) => void open(event.metaKey || event.ctrlKey)}
            onContextMenu={onContextMenu}
          >
            <FileTypeGlyph name={target.path} className="icon-xs" />
            <span>{givenLabel ?? label}</span>
          </ChipButton>
        </Tooltip>
      )}
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

const renderLink = (href: string, label: React.ReactNode) => (
  <ConversationFileLink token={href} source="href" label={label} />
)
export function ConversationMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const streamed = useRef(streaming)
  if (streaming) streamed.current = true
  const options = useMemo(
    () => ({ codeBlock: CodeBlock, streaming, renderText: conversationText, renderLink }),
    [streaming],
  )
  return streamed.current ? <StreamingMarkdown source={text} options={options} /> : <>{renderMarkdown(text, options)}</>
}
