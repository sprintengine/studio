import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceSkill } from '../../../../../shared/electron-api'
import type { ScannedSkill, SkillSource } from '../../../../../shared/skills'
import { SKILL_HARNESS_DIR } from '../../../../../shared/skill-harnesses'
import { Modal, ModalHeader } from '../../ui/Modal'
import { SkillReader } from '../../workspace/globalSurface/extensions/skills/SkillReader'

type ReaderTarget = { source: SkillSource; skill: ScannedSkill; readFile?: (path: string) => Promise<string> }

export async function resolveComposerSkill(workspaceRoot: string | null, skill: WorkspaceSkill): Promise<ReaderTarget> {
  if (
    workspaceRoot &&
    skill.installState !== 'available' &&
    !/[\\/]/u.test(skill.id) &&
    skill.id !== '.' &&
    skill.id !== '..'
  ) {
    for (const harness of skill.harnesses) {
      const directory = SKILL_HARNESS_DIR[harness]
      if (!directory) continue
      const root = `${workspaceRoot.replace(/[\\/]$/u, '')}/${directory}/skills/${skill.id}`
      if (!(await window.api.pathExists(`${root}/SKILL.md`))) continue
      const files: ScannedSkill['files'] = []
      const pending = ['']
      while (pending.length) {
        const relative = pending.shift()!
        const entries = await window.api.readdir(`${root}/${relative}`)
        for (const entry of entries) {
          if (!entry.name || entry.name === '.' || entry.name === '..' || /[\\/]/u.test(entry.name)) continue
          const path = relative ? `${relative}/${entry.name}` : entry.name
          if (entry.isDir) {
            if (path.split('/').length < 8 && !entry.name.startsWith('.')) pending.push(path)
          } else files.push({ path, isEntry: path === 'SKILL.md', size: 0, blobSha: '' })
          if (files.length + pending.length > 2000) throw new Error('This skill contains too many files to preview.')
        }
      }
      const allowed = new Set(files.map((file) => file.path))
      return {
        source: {
          id: root,
          kind: 'local',
          name: skill.name,
          repo: '',
          path: root,
          monogram: 'SK',
          blurb: '',
          commitSha: '',
          scannedAt: '',
        },
        skill: {
          id: skill.id,
          name: skill.name,
          description: skill.description ?? '',
          group: '',
          files,
          allowedTools: [],
          hasExecutables: false,
        },
        readFile: async (path) => {
          if (!allowed.has(path)) throw new Error('The requested file is not part of this skill.')
          return window.api.readfile(`${root}/${path}`)
        },
      }
    }
  }
  const sources = await window.api.skillsListSources()
  if (!sources.ok) throw new Error(sources.message)
  for (const source of sources.sources) {
    const result = await window.api.skillsGetScan({ sourceId: source.id })
    if (!result.ok) continue
    const scanned = result.scan.skills.find(
      (candidate) => candidate.id === skill.id || candidate.id.split('/').at(-1) === skill.id,
    )
    if (scanned) return { source, skill: scanned }
  }
  throw new Error('The source files for this skill are no longer available.')
}

export function useComposerSkillReader(workspaceRoot: string | null) {
  const [state, setState] = useState<{ name: string; target?: ReaderTarget; error?: string } | null>(null)
  const generation = useRef(0)
  useEffect(
    () => () => {
      generation.current++
    },
    [workspaceRoot],
  )
  const close = useCallback(() => {
    generation.current++
    setState(null)
  }, [])
  const openSkill = useCallback(
    (skill: WorkspaceSkill) => {
      const current = ++generation.current
      setState({ name: skill.name })
      void resolveComposerSkill(workspaceRoot, skill)
        .then((target) => {
          if (generation.current === current) setState({ name: skill.name, target })
        })
        .catch((error: unknown) => {
          if (generation.current === current)
            setState({ name: skill.name, error: error instanceof Error ? error.message : String(error) })
        })
    },
    [workspaceRoot],
  )
  const reader = state ? (
    <Modal open onClose={close} label={state.name} size="workbench" layout="panel">
      <ModalHeader title={state.name} onClose={close} />
      <div className="mt-4 min-h-0 flex-1 border-t border-[color:var(--border-subtle)]">
        {state.target ? (
          <SkillReader key={state.target.source.id + state.target.skill.id} {...state.target} />
        ) : (
          <p role="status" className="p-4 text-meta">
            {state.error ?? 'Reading skill…'}
          </p>
        )}
      </div>
    </Modal>
  ) : null
  return { openSkill, reader }
}
