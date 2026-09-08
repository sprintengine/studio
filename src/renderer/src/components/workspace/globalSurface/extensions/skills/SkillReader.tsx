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
//
// It is laid out as a workbench: a rail on the left carrying what the skill
// declares about itself (`rail`) and then its files, and the open document on
// the right at a reading measure. The two scroll independently, so a long
// SKILL.md never carries the file list off screen, and the rail never pushes
// the document down. It used to be a 196px column inside a 420px side pane,
// where the document wrapped at thirty characters (extensions review,
// 2026-09-08).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ScannedSkill, SkillFileRef, SkillSource } from '../../../../../../../shared/skills'
import { GhostButton, InlineNotice, RowButton, Spinner, Tooltip } from '../../../../ui'
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
  rail,
}: {
  source: SkillSource
  skill: ScannedSkill
  /** What the skill declares about itself, set above its file list in the rail. */
  rail?: React.ReactNode
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
    // The document pane is its own scroll container now, so "back to the top"
    // is its scrollTop, not the page's.
    const pane = documentPane.current
    if (pane) pane.scrollTop = 0
  }, [activePath])

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[280px_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r border-[color:var(--border-subtle)] py-5 pl-6 pr-5">
        {rail}
        <SkillFileList files={files} activePath={active?.path ?? ''} onOpen={setActivePath} />
      </div>
      <div ref={documentPane} className="min-h-0 min-w-0 overflow-y-auto px-8 py-5">
        <div className="max-w-[74ch] min-w-0">
          {!active ? (
            <p className="text-body text-[color:var(--text-subtle)]">This skill lists no files.</p>
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
    <nav aria-label="Files in this skill" className="min-w-0">
      <p className="px-2 pb-2 text-meta font-medium text-[color:var(--text-muted)]">
        {`${files.length} file${files.length === 1 ? '' : 's'}`}
      </p>
      <ul role="list" className="flex flex-col gap-px">
        {files.map((file) => {
          const current = file.path === activePath
          return (
            <li key={file.path} className="min-w-0">
              {/* A long path still truncates in the rail: hover or focus
                  carries the whole path it would install. */}
              <Tooltip content={file.path} placement="right" wrapperClassName="block w-full">
                {/* The kit's row button: this rail entry is the shape it names
                    — a file path with a size on the end. The fill, its inset
                    selection edge, the hover ground and `aria-current` come
                    with `selected`; the row's own contents stay here. */}
                <RowButton selected={current} onClick={() => onOpen(file.path)}>
                  <span
                    className={`min-w-0 flex-1 truncate font-mono text-meta ${
                      current ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-muted)]'
                    }`}
                  >
                    {file.path}
                  </span>
                  {file.isEntry ? (
                    <span className="shrink-0 text-meta text-[color:var(--text-subtle)]">Entry</span>
                  ) : null}
                  {/* A size is drawn only when one is known. A repository read
                      over git lists its files without their sizes — a size is
                      only knowable from the blob, and fetching every blob to
                      print a number is what the transport exists to avoid — so
                      the gutter is simply empty there rather than "0 B", which
                      would be a measurement nobody took (git-transport ruling,
                      owner 2026-09-08). */}
                  {file.size > 0 ? (
                    <span className="shrink-0 text-meta tabular-nums text-[color:var(--text-subtle)]">
                      {formatSkillFileSize(file.size)}
                    </span>
                  ) : null}
                </RowButton>
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
      <div className="flex items-center gap-2 py-6 text-body text-[color:var(--text-muted)]">
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
      <pre className="overflow-x-auto rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-3 font-mono text-meta leading-[1.7] text-[color:var(--text-default)]">
        {read.content}
      </pre>
    )
  }

  const body = stripSkillFrontmatter(read.content).trim()
  if (!body) {
    return (
      <p className="text-body text-[color:var(--text-subtle)]">
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
