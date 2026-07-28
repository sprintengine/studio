// One skill, opened: what it is, what it may run, and what it would install.
//
// A skill is instructions an agent will follow and, often, scripts it will run,
// so everything the scan knows about it is disclosed before Install: the
// frontmatter description an agent matches on, the declared `allowed-tools`,
// whether it ships executables, and every file that would be written into the
// workspace. Reading the file contents is the reader's job (T3) and lands in
// this same page — this is the frame it fills, not a placeholder for it.

import React, { useState } from 'react'

import type { ScannedSkill, SkillSource } from '../../../../../../../shared/skills'
import { PrimaryButton } from '../../../../ui'
import { FOCUS_RING_CLASS } from '../../../../ui/tokens'
import { SourceMonogram } from './SourceMonogram'
import {
  formatSkillFileSize,
  sourceDisplayMonogram,
  sourceDisplayName,
  type SkillInstallAvailability,
} from './skillsSurfaceModel'

// A skill of 128 files would otherwise push everything after it off the page.
const FILE_PREVIEW_COUNT = 10

export function SkillPage({
  source,
  skill,
  installed,
  installing,
  availability,
  onInstall,
  onBack,
  embedded,
}: {
  source: SkillSource
  skill: ScannedSkill
  installed: boolean
  installing: boolean
  availability: SkillInstallAvailability
  onInstall: () => void
  /** Back to the source listing. Omitted when the source IS this one skill. */
  onBack?: () => void
  /** Rendered under a source header that already states the repository and its
   *  counts (the solo layout), so this page states neither a second time. */
  embedded?: boolean
}): JSX.Element {
  const [descriptionOpen, setDescriptionOpen] = useState(false)
  const [allFiles, setAllFiles] = useState(false)
  const files = [...skill.files].sort((a, b) =>
    a.isEntry === b.isEntry ? comparePaths(a.path, b.path) : a.isEntry ? -1 : 1,
  )
  const longDescription = skill.description.length > 200

  return (
    <div className="min-w-0">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className={`mb-2.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
        >
          <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {sourceDisplayName(source)}
        </button>
      ) : null}

      <div className="flex items-start gap-3">
        {embedded ? null : <SourceMonogram monogram={sourceDisplayMonogram(source)} size="lg" />}
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-[color:var(--text-strong)]">{skill.name}</h3>
          {embedded ? null : (
            <p className="mt-0.5 text-[11px] text-[color:var(--text-muted)]">
              {[sourceDisplayName(source), `${files.length} file${files.length === 1 ? '' : 's'}`].join(' · ')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {installed ? (
            <span className="text-[11px] text-[color:var(--text-muted)]">Installed</span>
          ) : null}
          <PrimaryButton onClick={onInstall} disabled={!availability.enabled || installing}>
            {installing ? 'Installing…' : installed ? 'Reinstall' : 'Install skill'}
          </PrimaryButton>
        </div>
      </div>

      {availability.reason ? (
        <p className="mt-2 text-[11px] text-[color:var(--text-subtle)]">{availability.reason}</p>
      ) : null}

      {skill.description ? (
        <div className="mt-2.5 max-w-[74ch]">
          <p
            className={`text-[12px] leading-5 text-[color:var(--text-muted)] ${
              longDescription && !descriptionOpen ? 'line-clamp-3' : ''
            }`}
          >
            {skill.description}
          </p>
          {longDescription ? (
            <button
              type="button"
              onClick={() => setDescriptionOpen((open) => !open)}
              className={`mt-1 rounded text-[11px] text-[color:var(--text-muted)] underline underline-offset-2 hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
            >
              {descriptionOpen ? 'Less' : 'More'}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-2.5 text-[12px] text-[color:var(--text-subtle)]">
          This skill's entry document declares no description.
        </p>
      )}

      {skill.allowedTools.length > 0 || skill.hasExecutables ? (
        <section className="mt-4 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-3">
          <h4 className="text-[11px] font-medium text-[color:var(--text-muted)]">What it may run</h4>
          {skill.allowedTools.length > 0 ? (
            <ul role="list" className="mt-1.5 flex flex-wrap gap-1">
              {skill.allowedTools.map((tool) => (
                <li
                  key={tool}
                  className="rounded-[3px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-1.5 py-0.5 font-mono text-[10.5px] text-[color:var(--text-default)]"
                >
                  {tool}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 border-l-2 border-[color:var(--border-strong)] pl-2.5 text-[11px] leading-5 text-[color:var(--text-subtle)]">
            {skill.allowedTools.length > 0
              ? "Declared by the skill's own allowed-tools. "
              : 'This skill declares no allowed-tools. '}
            {skill.hasExecutables
              ? 'It ships executable files, which an agent may run once installed.'
              : 'It ships no executable files.'}
          </p>
        </section>
      ) : null}

      <div className="mt-4 flex items-baseline gap-2 border-b border-[color:var(--border-subtle)] pb-1.5">
        <h4 className="text-[12px] font-medium text-[color:var(--text-default)]">Files</h4>
        <span className="text-[11px] tabular-nums text-[color:var(--text-subtle)]">{files.length}</span>
      </div>
      {/* A file row states what would be written, and nothing more: opening a
          file to read it is the reader's affordance and arrives with it. */}
      <ul role="list" className="mt-1.5 flex flex-col gap-px">
        {(allFiles ? files : files.slice(0, FILE_PREVIEW_COUNT)).map((file) => (
          <li key={file.path} className="flex items-center gap-2 px-2 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[color:var(--text-muted)]">
              {file.path}
            </span>
            {file.isEntry ? (
              <span className="shrink-0 text-[10.5px] text-[color:var(--text-subtle)]">Entry</span>
            ) : null}
            <span className="shrink-0 text-[10.5px] tabular-nums text-[color:var(--text-disabled)]">
              {formatSkillFileSize(file.size)}
            </span>
          </li>
        ))}
      </ul>
      {files.length > FILE_PREVIEW_COUNT ? (
        <button
          type="button"
          onClick={() => setAllFiles((open) => !open)}
          className={`mt-1.5 rounded px-2 text-[11px] text-[color:var(--text-muted)] underline underline-offset-2 hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
        >
          {allFiles ? 'Show fewer' : `Show all ${files.length} files`}
        </button>
      ) : null}
      <p className="mt-3 text-[11px] text-[color:var(--text-subtle)]">
        Installing copies these files into the skills directory of every agent CLI on this machine, inside
        the open workspace.
      </p>
    </div>
  )
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
