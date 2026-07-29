// Add a skill source: a centred modal, not a right-hand aside. The application
// does not configure things in an aside, and the right edge is reserved for a
// future skills surface. Escape, the scrim, and the padding around the modal
// all dismiss it — that is the shared Modal's contract.
//
// Paste a repository, scan it, and read what the scan found. The counts shown
// are the scan's own — skills, groups, files, and the commit it pinned — never
// a simulated walk: the surface has no per-path log to show, and inventing one
// would be theatre over a real result.
//
// Scanning and adding are one call (`skillsAddSource` walks the tree and stores
// the source with its scan), so the modal says so plainly and offers Remove for
// a repository that turned out to be the wrong one. Nothing installs here —
// adding a source and taking skills from it stay separate acts.

import React, { useEffect, useState } from 'react'

import type { ScanResult, SkillSource } from '../../../../../../../shared/skills'
import { sourceLayout } from '../../../../../../../shared/skills'
import { GhostButton, InlineNotice, Input, PrimaryButton, Spinner } from '../../../../ui'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../../../ui/Modal'
import { pluralSkills, shortCommit } from './skillsSurfaceModel'

const LAYOUT_NOTE: Record<string, string> = {
  solo: 'One skill, so it opens as a skill page.',
  flat: 'Opens as one list.',
  grouped: 'Opens two-pane, one group at a time.',
  search: 'Opens search-first — past the browsing threshold, it stays empty until asked.',
  none: 'Nothing in it scanned as a skill: a skill is a directory containing SKILL.md.',
}

type AddPhase =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'added'; source: SkillSource; scan: ScanResult }
  | { kind: 'failed'; message: string }

export function AddSkillSourceModal({
  open,
  initialRepo = '',
  onClose,
  onAdded,
  onRemoved,
}: {
  open: boolean
  /** A candidate chosen in Discover. It arrives in the same field a pasted
   *  repository lands in, and takes the same path from there. */
  initialRepo?: string
  onClose: () => void
  /** A source landed in the list; the surface reloads and opens it. */
  onAdded: (source: SkillSource) => void
  /** The just-added source was removed again. */
  onRemoved: () => void
}): JSX.Element {
  const [repo, setRepo] = useState(initialRepo)
  const [phase, setPhase] = useState<AddPhase>({ kind: 'idle' })
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    if (!open) return
    setRepo(initialRepo)
    setPhase({ kind: 'idle' })
    setRemoving(false)
  }, [open, initialRepo])

  const scan = async (): Promise<void> => {
    const value = repo.trim()
    if (value.length === 0) return
    if (typeof window.api.skillsAddSource !== 'function') {
      setPhase({ kind: 'failed', message: 'Skills need an app restart before they are available.' })
      return
    }
    setPhase({ kind: 'scanning' })
    try {
      // `replace` re-scans a repository already in the list rather than
      // refusing it, which is what a user who pastes it twice means.
      const result = await window.api.skillsAddSource({ repo: value, replace: true })
      if (!result.ok) {
        setPhase({ kind: 'failed', message: result.message })
        return
      }
      setPhase({ kind: 'added', source: result.source, scan: result.scan })
      onAdded(result.source)
    } catch (error) {
      setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const remove = async (sourceId: string): Promise<void> => {
    if (typeof window.api.skillsRemoveSource !== 'function') return
    setRemoving(true)
    const result = await window.api.skillsRemoveSource({ sourceId })
    setRemoving(false)
    if (!result.ok) {
      setPhase({ kind: 'failed', message: result.message })
      return
    }
    onRemoved()
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy="add-skill-source-title" width={520}>
      <ModalHeader
        titleId="add-skill-source-title"
        title="Add a skill source"
        subtitle="A public GitHub repository. Multicode walks it and finds the skills."
        onClose={onClose}
      />
      <ModalBody className="flex flex-col gap-3.5">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-[color:var(--text-default)]">
            Repository
          </span>
          <Input
            value={repo}
            autoFocus
            disabled={phase.kind === 'scanning' || phase.kind === 'added'}
            onChange={(event) => setRepo(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void scan()
            }}
            placeholder="owner/repo"
            aria-label="Repository"
            className="font-mono"
          />
          <span className="mt-1.5 block text-[11px] text-[color:var(--text-subtle)]">
            A github.com address, or owner/repo. Pins to the current commit of the default branch.
          </span>
        </label>

        {phase.kind === 'scanning' ? (
          <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-muted)]">
            <Spinner size={14} />
            {`Walking ${repo.trim()}…`}
          </div>
        ) : null}

        {phase.kind === 'failed' ? (
          <InlineNotice tone="error" title="That repository was not added." hint={phase.message} />
        ) : null}

        {phase.kind === 'added' ? <ScanSummary source={phase.source} scan={phase.scan} /> : null}
      </ModalBody>
      <ModalFooter>
        {phase.kind === 'added' ? (
          <>
            <GhostButton
              size="md"
              disabled={removing}
              onClick={() => void remove(phase.source.id)}
            >
              {removing ? 'Removing…' : 'Remove source'}
            </GhostButton>
            <PrimaryButton size="md" onClick={onClose}>
              Done
            </PrimaryButton>
          </>
        ) : (
          <>
            <GhostButton size="md" onClick={onClose}>
              Cancel
            </GhostButton>
            <PrimaryButton
              size="md"
              onClick={() => void scan()}
              disabled={repo.trim().length === 0 || phase.kind === 'scanning'}
            >
              {phase.kind === 'scanning' ? 'Scanning…' : 'Scan and add'}
            </PrimaryButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  )
}

function ScanSummary({ source, scan }: { source: SkillSource; scan: ScanResult }): JSX.Element {
  const layout = sourceLayout(scan)
  const commit = shortCommit(scan.commitSha || source.commitSha)
  return (
    <div className="rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] p-3">
      <p className="text-[12px] font-medium text-[color:var(--text-strong)]">
        {scan.groups.length > 0
          ? `${pluralSkills(scan.skills.length)} in ${scan.groups.length} ${
              scan.groupingSignal === 'manifest' ? 'plugins' : 'categories'
            }.`
          : `${pluralSkills(scan.skills.length)}.`}
      </p>
      <p className="mt-1 text-[11px] text-[color:var(--text-muted)]">
        {`${scan.fileCount} file${scan.fileCount === 1 ? '' : 's'}${commit ? `. Pinned at ${commit}` : ''}. ${
          LAYOUT_NOTE[layout] ?? ''
        }`}
      </p>
      <p className="mt-2 border-l-2 border-[color:var(--border-strong)] pl-2.5 text-[11px] text-[color:var(--text-subtle)]">
        {`${source.repo || source.name} is now one of your sources. Nothing is installed yet — take skills from it when you want them.`}
      </p>
    </div>
  )
}
