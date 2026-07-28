// The reader: every file a skill would install, and any of them rendered.
//
// A skill is instructions an agent will follow and often scripts it will run,
// so the file list is not a manifest to take on trust — each row opens. Bytes
// are fetched one file at a time, on demand: a skill of 127 files is read the
// way a person reads it, not prefetched because it was opened.
//
// Relative links inside a document resolve against this skill's own manifest,
// so SKILL.md → LOGIC.md opens in place. A link whose target the scan never
// carried is stated as missing rather than rendered as if it would work.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ScannedSkill, SkillFileRef, SkillSource } from '../../../../../../../shared/skills'
import { GhostButton, InlineNotice, Spinner, Tooltip } from '../../../../ui'
import { FOCUS_RING_CLASS } from '../../../../ui/tokens'
import { renderMarkdown, type MarkdownLinkResolver } from '../../../../../utils/markdown'
import {
  defaultSkillFilePath,
  describeDeadSkillLink,
  formatSkillFileSize,
  isMarkdownSkillFile,
  orderSkillFiles,
  resolveSkillLink,
  stripSkillFrontmatter,
} from './skillsSurfaceModel'

const MISSING_API_MESSAGE = 'Skills need an app restart before they are available.'

type SkillFileRead =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; content: string }

export function SkillReader({
  source,
  skill,
}: {
  source: SkillSource
  skill: ScannedSkill
}): JSX.Element {
  const files = useMemo(() => orderSkillFiles(skill.files), [skill.files])
  const [activePath, setActivePath] = useState(() => defaultSkillFilePath(files))
  const active = files.find((file) => file.path === activePath) ?? files[0] ?? null
  const { read, retry } = useSkillFile(source.id, skill.id, active?.path ?? '')

  // A link followed from three screens down would otherwise open the next file
  // already scrolled past its own beginning. Only when it is above the fold —
  // a reader that has not scrolled stays exactly where it is.
  const documentPane = useRef<HTMLDivElement>(null)
  const firstFile = useRef(true)
  useEffect(() => {
    if (firstFile.current) {
      firstFile.current = false
      return
    }
    const pane = documentPane.current
    if (pane && pane.getBoundingClientRect().top < 0) pane.scrollIntoView({ block: 'start' })
  }, [activePath])

  return (
    <div className="mt-5 grid min-w-0 items-start gap-0 lg:grid-cols-[196px_minmax(0,1fr)]">
      <SkillFileList files={files} activePath={active?.path ?? ''} onOpen={setActivePath} />
      <div
        ref={documentPane}
        className="min-w-0 border-t border-[color:var(--border-subtle)] pt-4 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0"
      >
        <div className="max-w-[74ch] min-w-0">
          {!active ? (
            <p className="text-[12px] text-[color:var(--text-subtle)]">This skill lists no files.</p>
          ) : (
            <SkillDocument
              file={active}
              read={read}
              files={files}
              onOpenFile={setActivePath}
              onRetry={retry}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function SkillFileList({
  files,
  activePath,
  onOpen,
}: {
  files: SkillFileRef[]
  activePath: string
  onOpen: (path: string) => void
}): JSX.Element {
  return (
    <nav aria-label="Files in this skill" className="min-w-0 pb-4 lg:sticky lg:top-0 lg:pb-0 lg:pr-4">
      <p className="px-2 pb-2 text-[11px] text-[color:var(--text-subtle)]">
        {`${files.length} file${files.length === 1 ? '' : 's'}`}
      </p>
      <ul role="list" className="flex flex-col gap-px">
        {files.map((file) => {
          const current = file.path === activePath
          return (
            <li key={file.path} className="min-w-0">
              {/* The rail is 196px, so `scripts/block-dangerous-git.sh` reads
                  truncated: hover or focus carries the path it would install. */}
              <Tooltip content={file.path} placement="right" wrapperClassName="block w-full">
                <button
                  type="button"
                  onClick={() => onOpen(file.path)}
                  aria-current={current ? 'true' : undefined}
                  className={`flex w-full items-center gap-2 rounded-md border-l-2 px-2 py-1 text-left transition-colors ${FOCUS_RING_CLASS} ${
                    current
                      ? 'border-[color:var(--accent-primary)] bg-[color:var(--bg-selected)]'
                      : 'border-transparent hover:bg-[color:var(--bg-hover)]'
                  }`}
                >
                  <span
                    className={`min-w-0 flex-1 truncate font-mono text-[11px] ${
                      current ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-muted)]'
                    }`}
                  >
                    {file.path}
                  </span>
                  {file.isEntry ? (
                    <span className="shrink-0 text-[10.5px] text-[color:var(--text-subtle)]">Entry</span>
                  ) : null}
                  <span className="shrink-0 text-[10.5px] tabular-nums text-[color:var(--text-disabled)]">
                    {formatSkillFileSize(file.size)}
                  </span>
                </button>
              </Tooltip>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/** One file, rendered. Separated from the read so it can be exercised with
 *  bytes in hand — including bytes that try to inject markup. */
export function SkillDocument({
  file,
  read,
  files,
  onOpenFile,
  onRetry,
}: {
  file: SkillFileRef
  read: SkillFileRead
  files: SkillFileRef[]
  onOpenFile: (path: string) => void
  onRetry: () => void
}): JSX.Element {
  const links: MarkdownLinkResolver = useMemo(
    () => ({
      resolve: (href) => {
        const target = resolveSkillLink(files, file.path, href)
        if (!target) return null
        return target.kind === 'file'
          ? { kind: 'file', path: target.path }
          : { kind: 'dead', reason: describeDeadSkillLink(target.target) }
      },
      open: onOpenFile,
    }),
    [files, file.path, onOpenFile],
  )

  if (read.status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-6 text-[12px] text-[color:var(--text-muted)]">
        <Spinner size={14} />
        {`Reading ${file.path}…`}
      </div>
    )
  }

  if (read.status === 'error') {
    return (
      <InlineNotice
        tone="warn"
        title={`${file.path} could not be read.`}
        detail={read.message}
        action={<GhostButton onClick={onRetry}>Try again</GhostButton>}
      />
    )
  }

  if (!isMarkdownSkillFile(file.path)) {
    return (
      <pre className="overflow-x-auto rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-3 font-mono text-[11px] leading-[1.7] text-[color:var(--text-default)]">
        {read.content}
      </pre>
    )
  }

  const body = stripSkillFrontmatter(read.content).trim()
  if (!body) {
    return (
      <p className="text-[12px] text-[color:var(--text-subtle)]">
        {`${file.path} carries frontmatter and no body.`}
      </p>
    )
  }
  return <>{renderMarkdown(body, { density: 'compact', links })}</>
}

/**
 * One file's bytes, fetched when it is opened and remembered for as long as the
 * skill stays open — so walking SKILL.md → LOGIC.md → SKILL.md costs one read
 * per file, and opening a skill never reads more than the file being shown.
 */
function useSkillFile(
  sourceId: string,
  skillId: string,
  path: string,
): { read: SkillFileRead; retry: () => void } {
  const [read, setRead] = useState<SkillFileRead>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)
  // Keyed by source AND skill, not by path alone: two skills both have a
  // SKILL.md, and serving one skill's bytes under the other's name is the one
  // way a cache here could lie.
  const cache = useRef<Map<string, string>>(new Map())
  const key = `${sourceId}::${skillId}::${path}`

  useEffect(() => {
    if (!path) return
    const cached = cache.current.get(key)
    if (cached !== undefined) {
      setRead({ status: 'ready', content: cached })
      return
    }
    if (typeof window.api.skillsReadFile !== 'function') {
      setRead({ status: 'error', message: MISSING_API_MESSAGE })
      return
    }
    let cancelled = false
    setRead({ status: 'loading' })
    void window.api
      .skillsReadFile({ sourceId, skillId, path })
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setRead({ status: 'error', message: result.message })
          return
        }
        cache.current.set(key, result.content)
        setRead({ status: 'ready', content: result.content })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setRead({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      cancelled = true
    }
  }, [key, sourceId, skillId, path, nonce])

  const retry = useCallback(() => {
    cache.current.delete(key)
    setNonce((value) => value + 1)
  }, [key])

  return { read, retry }
}
