// One skill, opened: what it is, what it may run, and what it would install.
//
// A skill is instructions an agent will follow and, often, scripts it will run,
// so everything the scan knows about it is disclosed before Install: the
// frontmatter description an agent matches on, the declared `allowed-tools`,
// whether it ships executables, and every file that would be written into the
// workspace — each of which opens in the reader below, so nothing here is
// offered on trust alone.

import React, { useState } from 'react'

import type { ScannedSkill, SkillSource } from '../../../../../../../shared/skills'
import { PrimaryButton } from '../../../../ui'
import { FOCUS_RING_CLASS } from '../../../../ui/tokens'
import { SkillReader } from './SkillReader'
import { SourceMonogram } from './SourceMonogram'
import {
  sourceDisplayMonogram,
  sourceDisplayName,
  type SkillInstallAvailability,
} from './skillsSurfaceModel'

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
  const fileCount = skill.files.length
  const longDescription = skill.description.length > 200

  return (
    <div className="min-w-0">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className={`mb-2.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-meta text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
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
          <h3 className="text-title font-semibold text-[color:var(--text-strong)]">{skill.name}</h3>
          {embedded ? null : (
            /* The back crumb above already names the source, so repeating it
               here would state the same repository twice, two lines apart. */
            <p className="mt-0.5 text-meta text-[color:var(--text-muted)]">
              {[onBack ? null : sourceDisplayName(source), `${fileCount} file${fileCount === 1 ? '' : 's'}`]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {installed ? (
            <span className="text-meta text-[color:var(--text-muted)]">Installed</span>
          ) : null}
          <PrimaryButton onClick={onInstall} disabled={!availability.enabled || installing}>
            {installing ? 'Installing…' : installed ? 'Reinstall' : 'Install skill'}
          </PrimaryButton>
        </div>
      </div>

      {availability.reason ? (
        <p className="mt-2 text-meta text-[color:var(--text-subtle)]">{availability.reason}</p>
      ) : null}

      {skill.description ? (
        <div className="mt-2.5 max-w-[74ch]">
          <p
            className={`text-body leading-5 text-[color:var(--text-muted)] ${
              longDescription && !descriptionOpen ? 'line-clamp-3' : ''
            }`}
          >
            {skill.description}
          </p>
          {longDescription ? (
            <button
              type="button"
              onClick={() => setDescriptionOpen((open) => !open)}
              className={`mt-1 rounded text-meta text-[color:var(--text-muted)] underline underline-offset-2 hover:text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
            >
              {descriptionOpen ? 'Less' : 'More'}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-2.5 text-body text-[color:var(--text-subtle)]">
          This skill's entry document declares no description.
        </p>
      )}

      {skill.allowedTools.length > 0 || skill.hasExecutables ? (
        <section className="mt-4 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-3">
          <h4 className="text-meta font-medium text-[color:var(--text-muted)]">What it may run</h4>
          {skill.allowedTools.length > 0 ? (
            <ul role="list" className="mt-1.5 flex flex-wrap gap-1">
              {skill.allowedTools.map((tool) => (
                <li
                  key={tool}
                  className="rounded-[3px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-1.5 py-0.5 font-mono text-meta text-[color:var(--text-default)]"
                >
                  {tool}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 border-l-2 border-[color:var(--border-strong)] pl-2.5 text-meta leading-5 text-[color:var(--text-subtle)]">
            {skill.allowedTools.length > 0
              ? "Declared by the skill's own allowed-tools. "
              : 'This skill declares no allowed-tools. '}
            {skill.hasExecutables
              ? 'It ships executable files, which an agent may run once installed.'
              : 'It ships no executable files.'}
          </p>
        </section>
      ) : null}

      {/* The file list is the reader's own rail: every file that would be
          written is listed, and each one opens. */}
      <SkillReader key={`${source.id}::${skill.id}`} source={source} skill={skill} />

      <p className="mt-5 border-t border-[color:var(--border-subtle)] pt-3 text-meta text-[color:var(--text-subtle)]">
        Installing copies this skill's files into the skills directory of every agent CLI on this machine,
        inside the open workspace.
      </p>
    </div>
  )
}
