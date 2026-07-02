import { useEffect, useState } from 'react'
import {
  DESIGN_SYSTEM_ATTACHED_PROMPT_LINE,
  type DesignSystemAttachSource,
} from '../../../../../shared/design-system/attach'
import { DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME } from '../../../../../shared/design-system/bundle-scaffold'
import type { DesignSystemLibraryEntry } from '../../../../../shared/design-system/library'
import { GhostButton } from '../../ui'
import { pathJoin } from '../../../utils/paths'

// Attach-a-design-system section of the wizard's Advanced setup, shared by
// the standard, Sprint Engine, and Design Wizard flows. Follows the
// KnowledgeStep pattern: a real state read up front (library list + existing
// design-system/ pre-check), explicit unavailable/empty/conflict states, and
// a selection the wizard applies at create time through the attach IPC — the
// picker itself never copies anything.

type LibraryState =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: DesignSystemLibraryEntry[]; rejectedCount: number }
  | { kind: 'unavailable'; message: string }

// Bonus path after a successful attach when the wizard also committed a
// knowledge root: a pointer note next to the graph, composed from the shared
// launch-line contract so the two can never drift. The bundle stays the
// source of truth; callers treat a write failure as non-fatal.
export function buildDesignSystemKnowledgeNote(name: string, version: string): string {
  return [
    '# Design system',
    '',
    `Attached bundle: ${name}@${version}.`,
    DESIGN_SYSTEM_ATTACHED_PROMPT_LINE,
    'This note is a pointer, not a second source of truth: the bundle documents itself.',
    '',
  ].join('\n')
}

/** Writes the pointer note unless one already exists (never overwrites). */
export async function writeDesignSystemKnowledgeNote(input: {
  workspaceRoot: string
  knowledgeRoot: string
  name: string
  version: string
}): Promise<void> {
  const notePath = pathJoin(input.workspaceRoot, input.knowledgeRoot, 'design-system.md')
  if (await window.api.pathExists(notePath)) return
  await window.api.writefile(notePath, buildDesignSystemKnowledgeNote(input.name, input.version))
}

export type DesignSystemAttachStepProps = {
  /** Materialized workspace folder the bundle would be copied into. */
  workspaceRoot: string
  selection: DesignSystemAttachSource | null
  onSelect: (source: DesignSystemAttachSource | null) => void
}

function sourceKey(source: DesignSystemAttachSource | null): string {
  if (!source) return 'none'
  return source.kind === 'library' ? `library:${source.name}@${source.version}` : `folder:${source.path}`
}

// A selection made before the conflict pre-check trips is stale: attach would
// refuse it, the picker is withheld, and the UI would offer no way to unselect.
// Called from the pre-check effect so the selection clears the moment the
// conflict state renders. Exported for the test's contract on this decision.
export function clearStaleAttachSelection(input: {
  existingBundle: boolean | null
  selection: DesignSystemAttachSource | null
  onSelect: (source: DesignSystemAttachSource | null) => void
}): void {
  if (input.existingBundle === true && input.selection != null) input.onSelect(null)
}

export function DesignSystemAttachStep({ workspaceRoot, selection, onSelect }: DesignSystemAttachStepProps) {
  const [library, setLibrary] = useState<LibraryState>({ kind: 'loading' })
  // null = pre-check still running. True renders the conflict state: attach
  // never overwrites, so an existing design-system/ disables the picker.
  const [existingBundle, setExistingBundle] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .listDesignSystemLibrary()
      .then((result) => {
        if (cancelled) return
        setLibrary({ kind: 'ready', entries: result.entries, rejectedCount: result.rejected.length })
      })
      .catch((error) => {
        if (cancelled) return
        setLibrary({
          kind: 'unavailable',
          message: error instanceof Error ? error.message : 'Could not read the design-system library.',
        })
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setExistingBundle(null)
    window.api
      .pathExists(pathJoin(workspaceRoot, DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME))
      .then((exists) => {
        if (!cancelled) setExistingBundle(exists)
      })
      .catch(() => {
        if (!cancelled) setExistingBundle(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  useEffect(() => {
    clearStaleAttachSelection({ existingBundle, selection, onSelect })
  }, [existingBundle, selection, onSelect])

  const chooseFolder = async () => {
    const dir = await window.api.openDir()
    if (!dir) return
    onSelect({ kind: 'folder', path: dir })
  }

  if (existingBundle) {
    return (
      <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
        This folder already has a <span className="font-mono text-[color:var(--text-default)]">design-system/</span> directory.
        Attach never overwrites or merges — the existing copy stays as it is.
      </p>
    )
  }

  const selectedKey = sourceKey(selection)
  const folderSelection = selection?.kind === 'folder' ? selection : null

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
        Copies a released bundle into <span className="font-mono text-[color:var(--text-default)]">design-system/</span> when
        the workspace is created; agents launched here are told to conform to it.
      </p>
      <div role="group" aria-label="Design system to attach" className="flex flex-col gap-1.5">
        <AttachChoiceRow
          active={selectedKey === 'none'}
          title="None"
          detail="Start without a design system."
          onSelect={() => onSelect(null)}
        />
        {library.kind === 'loading' ? (
          <p className="px-1 text-[12px] leading-5 text-[color:var(--text-subtle)]">Reading your library…</p>
        ) : null}
        {library.kind === 'unavailable' ? (
          <p className="px-1 text-[12px] leading-5 text-[color:var(--tone-error)]">
            The design-system library could not be read: {library.message}
          </p>
        ) : null}
        {library.kind === 'ready' && library.entries.length === 0 ? (
          <p className="px-1 text-[12px] leading-5 text-[color:var(--text-subtle)]">
            No releases in your library yet — release one from a Design system studio, or browse to a bundle folder below.
          </p>
        ) : null}
        {library.kind === 'ready'
          ? library.entries.map((entry) => {
              const source: DesignSystemAttachSource = {
                kind: 'library',
                name: entry.name,
                version: entry.version,
              }
              return (
                <AttachChoiceRow
                  key={sourceKey(source)}
                  active={selectedKey === sourceKey(source)}
                  title={`${entry.name}@${entry.version}`}
                  titleMono
                  detail={entry.summary}
                  onSelect={() => onSelect(source)}
                />
              )
            })
          : null}
        <AttachChoiceRow
          active={folderSelection != null}
          title={folderSelection ? folderSelection.path : 'Browse to a bundle folder…'}
          titleMono={folderSelection != null}
          detail={
            folderSelection
              ? 'This folder is validated as a bundle before anything is copied.'
              : 'Attach any released bundle from disk.'
          }
          onSelect={() => void chooseFolder()}
        />
      </div>
      {library.kind === 'ready' && library.rejectedCount > 0 ? (
        <p className="text-[11px] leading-4 text-[color:var(--text-subtle)]">
          {library.rejectedCount} release{library.rejectedCount === 1 ? '' : 's'} in the library could not be read and{' '}
          {library.rejectedCount === 1 ? 'is' : 'are'} not listed.
        </p>
      ) : null}
      {folderSelection ? (
        <div>
          <GhostButton
            size="sm"
            onClick={() => void chooseFolder()}
            className="border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]"
          >
            Choose a different folder…
          </GhostButton>
        </div>
      ) : null}
    </div>
  )
}

// aria-pressed buttons in a labelled group, matching GuidedChoiceCard in
// NewWorkspacePanel.tsx: radio semantics would promise arrow-key movement
// these Tab-navigated rows don't have, and the browse row opens a native
// dialog on activation, which selection-follows-focus arrows would fire.
function AttachChoiceRow({
  active,
  title,
  titleMono = false,
  detail,
  onSelect,
}: {
  active: boolean
  title: string
  titleMono?: boolean
  detail: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={`
        flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors
        focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
        ${active
          ? 'border-[color:var(--accent-primary-soft-strong)] bg-[color:var(--accent-primary-soft)]'
          : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface)] hover:border-[color:var(--color-5)]'}
      `}
    >
      <span
        className={`min-w-0 max-w-full truncate text-[12px] text-[color:var(--text-strong)] ${
          titleMono ? 'font-mono font-medium' : 'font-semibold'
        }`}
      >
        {title}
      </span>
      <span className="min-w-0 max-w-full truncate text-[12px] leading-4 text-[color:var(--text-muted)]">{detail}</span>
    </button>
  )
}
