import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { resolveComposerSkill } from './composerSkillReader'
import { AttachmentChip } from '../../ui/AttachmentChip'

test('installed skill reader lists supporting files and only reads listed paths', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const readfile = vi.fn(async () => '# Review instructions')
  const readdir = vi.fn(async (path: string) =>
    path.endsWith('/references')
      ? [{ name: 'rules.md', isDir: false }]
      : [
          { name: 'SKILL.md', isDir: false },
          { name: 'references', isDir: true },
        ],
  )
  Object.assign(globalThis, { window: { api: { pathExists: async () => true, readdir, readfile } } })
  try {
    const target = await resolveComposerSkill('/Users/dev/project', {
      id: 'review',
      name: 'Review',
      source: 'custom',
      harnesses: ['codex'],
      installState: 'installed',
    })
    expect(target.skill.files.map((file) => file.path)).toEqual(['SKILL.md', 'references/rules.md'])
    expect(await target.readFile!('references/rules.md')).toBe('# Review instructions')
    expect(readfile).toHaveBeenCalledWith('/Users/dev/project/.codex/skills/review/references/rules.md')
    await expect(target.readFile!('../outside')).rejects.toThrow('not part of this skill')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('attachment chip keeps inspection and removal as separate controls', () => {
  const html = renderToStaticMarkup(
    <AttachmentChip label="Review" removeLabel="Remove Review" onRemove={() => undefined}>
      <span>Inspect Review</span>
    </AttachmentChip>,
  )
  expect(html).toContain('Remove Review')
  expect(html).toContain('Inspect Review')
  expect(html.match(/<button/g)).toHaveLength(1)
})
