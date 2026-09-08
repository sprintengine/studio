// One skill, opened: what it is, what it may run, and what it would install.
//
// A skill is instructions an agent will follow and, often, scripts it will run,
// so everything the scan knows about it is disclosed before Install: the
// frontmatter description an agent matches on, the declared `allowed-tools`,
// whether it ships executables, and every file that would be written into the
// workspace — each of which opens in the reader below, so nothing here is
// offered on trust alone.

import React, { useState } from 'react'

import { skillDirName, skillNameWarning, type ScannedSkill, type SkillSource } from '../../../../../../../shared/skills'
import {
  Badge,
  DefinitionList,
  GhostButton,
  LinkButton,
  PrimaryButton,
  StatusDot,
  type DefinitionItem,
} from '../../../../ui'
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
  // The optional Agent Skills fields, shown only when the skill declares them:
  // a "License —" row on every skill that has no licence is noise
  // (https://agentskills.io/specification, fetched 2026-09-06).
  const declared: DefinitionItem[] = [
    ...(skill.license ? [{ term: 'License', description: skill.license }] : []),
    ...(skill.compatibility ? [{ term: 'Compatibility', description: skill.compatibility }] : []),
    ...Object.entries(skill.metadata ?? {}).map(([key, value]) => ({
      term: key,
      description: value,
    })),
  ]
  const nameWarning = skillNameWarning(skill.name, skillDirName(skill.id))

  return (
    <div className="min-w-0">
      {onBack ? (
        // The back crumb is the kit's dense ghost (26px on the control ramp),
        // not a hand-rolled 22px lookalike with its own radius and hover.
        <GhostButton size="xs" onClick={onBack} className="mb-2.5 -ml-2">
          <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
            <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {sourceDisplayName(source)}
        </GhostButton>
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

      {/* A name the specification would reject is a fact about the skill, not a
          reason to withhold it — so it is stated here and Install stays live. */}
      {nameWarning ? (
        <p className="mt-2 flex items-center gap-1.5 text-meta text-[color:var(--text-subtle)]">
          <StatusDot tone="warn" />
          {nameWarning}
        </p>
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
            // The kit's link button, `quiet` ink: the disclosure under a
            // clamped description is the case that variant is named for. Its
            // standing underline is the primitive's — now drawn in
            // `border.strong` rather than in the ink itself, so the rule sits
            // under the words instead of competing with them.
            //
            // The 4px gap moves to a wrapper because the primitive is `inline`
            // — that is what keeps it on the baseline of a sentence — and a
            // vertical margin on an inline box is ignored. Here it is not in a
            // sentence but under one, so the block that holds it owns the gap.
            <div className="mt-1">
              <LinkButton ink="quiet" onClick={() => setDescriptionOpen((open) => !open)}>
                {descriptionOpen ? 'Less' : 'More'}
              </LinkButton>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-2.5 text-body text-[color:var(--text-subtle)]">
          This skill's entry document declares no description.
        </p>
      )}

      {declared.length > 0 ? (
        <DefinitionList
          items={declared}
          className="mt-4 max-w-[74ch] border-t border-[color:var(--border-subtle)] pt-3"
        />
      ) : null}

      {skill.allowedTools.length > 0 || skill.hasExecutables ? (
        <section className="mt-4 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] p-3">
          <h4 className="text-meta font-medium text-[color:var(--text-muted)]">What it may run</h4>
          {skill.allowedTools.length > 0 ? (
            <ul role="list" className="mt-1.5 flex flex-wrap gap-1">
              {skill.allowedTools.map((tool) => (
                <li key={tool}>
                  {/* The kit's label badge, in the mono the tool names are
                      written in — not a third chip shape of this door's own. */}
                  <Badge tone="neutral" className="font-mono">
                    {tool}
                  </Badge>
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
