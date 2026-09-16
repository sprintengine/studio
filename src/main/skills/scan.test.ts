// The scan rule, against recorded repository trees.
//
// Each fixture in __fixtures__ is a real `GET /git/trees/{sha}?recursive=1`
// response at a pinned commit, trimmed to the fields the scan reads. No network
// runs here: the scan is a pure function of paths, modes and blob SHAs, which
// is exactly why one request can scan a whole repository.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ScanResult } from '../../shared/skills'
import { scanSkillTree, type SkillTreeEntry } from './scan'

// Resolved from the repo root, not __dirname: the suite runs from a bundle in
// node_modules/.cache, matching how every other main-process test is invoked.
const FIXTURES = join(process.cwd(), 'src', 'main', 'skills', '__fixtures__')

type RecordedTree = { repo: string; commitSha: string; truncated: boolean; tree: SkillTreeEntry[] }

function recorded(name: string): RecordedTree {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.tree.json`), 'utf8')) as RecordedTree
}

function scan(name: string, manifestName?: string): ScanResult {
  const tree = recorded(name)
  assert.equal(tree.truncated, false, `${name} fixture must be a complete tree`)
  const manifest = manifestName
    ? readFileSync(join(FIXTURES, `${manifestName}.marketplace.json`), 'utf8')
    : null
  return scanSkillTree({ entries: tree.tree, commitSha: tree.commitSha, marketplaceManifest: manifest })
}

/**
 * mattpocock/skills as it stood at the commit `mattpocock-skills.tree.json`
 * records, which is what these numbers are about. The repository has moved on
 * since — it holds 37 skills at head today (checked 2026-09-06) — and that is
 * not drift: the fixture is a pinned tree, and the scan rule is what is under
 * test here, not the current contents of somebody else's repository. Nothing in
 * this file reads the network.
 */
function mattpocock(): void {
  const result = scan('mattpocock-skills')
  assert.equal(recorded('mattpocock-skills').commitSha, '2ab958093e83e0ec752e6c1c5932da465bf23e0c')
  assert.equal(result.skills.length, 41)
  assert.equal(result.fileCount, 107)
  assert.equal(result.groupingSignal, 'folders')
  assert.deepEqual(result.groups, [
    'deprecated',
    'engineering',
    'in-progress',
    'misc',
    'personal',
    'productivity',
  ])

  // The repository ships a `.claude-plugin/marketplace.json`, but its single
  // plugin enumerates no skills, so it says nothing about grouping and the
  // folders must win rather than the whole repository collapsing to one group.
  const withManifest = scanSkillTree({
    entries: recorded('mattpocock-skills').tree,
    commitSha: '',
    marketplaceManifest: JSON.stringify({ plugins: [{ name: 'mattpocock-skills', skills: null }] }),
  })
  assert.equal(withManifest.groupingSignal, 'folders')
  assert.equal(withManifest.skills.length, 41)

  // A README beside a skill is one of that skill's files, never a skill.
  assert.ok(!result.skills.some((skill) => skill.id.endsWith('README.md')))
}

function anthropics(): void {
  const result = scan('anthropics-skills', 'anthropics-skills')
  // 20 SKILL.md files are in the tree and the manifest lists 19. The manifest
  // is the source's grouping, not its census: the Agent Skills specification
  // defines no collection manifest at all, so the twentieth directory — the
  // repository's `template/` — is still a skill, and lists under "Everything
  // else" rather than vanishing because a plugin list omitted it.
  const entryFiles = recorded('anthropics-skills').tree.filter(
    (entry) => entry.type === 'blob' && entry.path.endsWith('SKILL.md')
  )
  assert.equal(entryFiles.length, 20)
  assert.equal(result.skills.length, 20)
  assert.equal(result.groupingSignal, 'manifest')
  assert.deepEqual(result.groups, [
    'document-skills',
    'example-skills',
    'claude-api',
    'academy-guide',
    'discernment-nudge',
    'Everything else',
  ])

  const template = result.skills.find((skill) => skill.id === 'template')
  assert.ok(template, 'the directory the manifest forgot is still a skill')
  assert.equal(template.group, 'Everything else')
  assert.equal(result.skills.filter((skill) => skill.group === 'Everything else').length, 1)

  // The manifest groups skills that are flat on disk — every listed one sits in
  // `skills/`, so folder grouping could never have produced these five.
  assert.ok(
    result.skills
      .filter((skill) => skill.group !== 'Everything else')
      .every((skill) => skill.id.startsWith('skills/'))
  )
  // Every file in the tree that belongs to a skill is still counted, the
  // unlisted one included.
  assert.equal(result.fileCount, result.skills.reduce((total, skill) => total + skill.files.length, 0))
}

/**
 * The additive rule on a tree small enough to read: a manifest that lists one
 * of three skills groups that one and leaves the other two reachable.
 */
function manifestGroupingIsAdditive(): void {
  const entries: SkillTreeEntry[] = [
    { path: 'skills/alpha/SKILL.md', mode: '100644', type: 'blob', sha: 'a', size: 1 },
    { path: 'skills/beta/SKILL.md', mode: '100644', type: 'blob', sha: 'b', size: 1 },
    { path: 'template/SKILL.md', mode: '100644', type: 'blob', sha: 'c', size: 1 },
  ]
  const result = scanSkillTree({
    entries,
    commitSha: 'sha',
    marketplaceManifest: JSON.stringify({ plugins: [{ name: 'pack', skills: ['./skills/alpha'] }] }),
  })
  assert.equal(result.groupingSignal, 'manifest')
  assert.deepEqual(result.groups, ['pack', 'Everything else'])
  assert.deepEqual(
    result.skills.map((skill) => [skill.id, skill.group]),
    [
      ['skills/alpha', 'pack'],
      ['skills/beta', 'Everything else'],
      ['template', 'Everything else'],
    ]
  )
  assert.equal(result.fileCount, 3)

  // A manifest that lists every skill adds no group of its own.
  const complete = scanSkillTree({
    entries,
    commitSha: 'sha',
    marketplaceManifest: JSON.stringify({
      plugins: [{ name: 'pack', skills: ['./skills/alpha', './skills/beta', './template'] }],
    }),
  })
  assert.deepEqual(complete.groups, ['pack'])
}

function browserAct(): void {
  const result = scan('browser-act-skills')
  assert.equal(result.skills.length, 103)
  assert.equal(result.groupingSignal, 'folders')
  assert.equal(result.groups.length, 6)
  const rootBucket = result.skills.filter((skill) => skill.group === '(repo root)')
  assert.equal(rootBucket.length, 2)
  assert.deepEqual(
    result.groups.filter((group) => group !== '(repo root)').sort(),
    ['ecommerce', 'lead-generation', 'search-research', 'social-listening', 'video-platforms']
  )

  // Two of these entries share a byte-identical SKILL.md across two categories.
  // They are two entries the source itself lists twice, so a blob-SHA dedupe
  // would be wrong here — the mirror rule must leave them alone.
  const trustpilot = result.skills.filter((skill) => skill.id.endsWith('/trustpilot-company-info'))
  assert.equal(trustpilot.length, 2)
  assert.equal(new Set(trustpilot.map((skill) => skill.files[0].blobSha)).size, 1)
}

function impeccable(): void {
  const tree = recorded('pbakaus-impeccable')
  const mirrors = tree.tree.filter(
    (entry) => entry.type === 'blob' && entry.path.endsWith('/SKILL.md')
  )
  assert.equal(mirrors.length, 15, 'the repository publishes one skill for fifteen harnesses')
  // Byte identity cannot collapse them: each mirror rewrites its own harness
  // path into the prose, so fifteen copies carry fourteen distinct blob SHAs.
  assert.equal(new Set(mirrors.map((entry) => entry.sha)).size, 14)

  const result = scan('pbakaus-impeccable')
  assert.equal(result.skills.length, 1)
  const [skill] = result.skills
  // Canonical copy: fewest path segments, ties to the first non-dot-prefixed
  // path. All fifteen are three segments deep, so `plugin/` wins.
  assert.equal(skill.id, 'plugin/skills/impeccable')
  assert.equal(skill.files.length, 128)
  assert.equal(result.fileCount, 128)
  assert.equal(result.groupingSignal, 'none')
  assert.deepEqual(result.groups, [])

  // The whole directory is the skill, subdirectory shape intact.
  assert.ok(skill.files.some((file) => file.path === 'SKILL.md' && file.isEntry))
  assert.ok(skill.files.some((file) => file.path.startsWith('reference/')))
  assert.ok(skill.files.some((file) => file.path.startsWith('scripts/')))
  assert.equal(skill.files.filter((file) => file.isEntry).length, 1)
  assert.equal(skill.hasExecutables, true)
}

function nonSkillDocuments(): void {
  const entries: SkillTreeEntry[] = [
    { path: 'docs/engineering/prototype.md', mode: '100644', type: 'blob', sha: 'a', size: 1 },
    { path: 'skills/alpha/SKILL.md', mode: '100644', type: 'blob', sha: 'b', size: 1 },
    { path: 'skills/alpha/README.md', mode: '100644', type: 'blob', sha: 'c', size: 1 },
    { path: 'skills/alpha/reference/notes.md', mode: '100644', type: 'blob', sha: 'd', size: 1 },
    { path: 'skills/beta/SKILL.md', mode: '100644', type: 'blob', sha: 'e', size: 1 },
    { path: 'skills/beta/README.md', mode: '100644', type: 'blob', sha: 'f', size: 1 },
  ]
  const result = scanSkillTree({ entries, commitSha: 'sha' })
  assert.deepEqual(
    result.skills.map((skill) => skill.id),
    ['skills/alpha', 'skills/beta']
  )
  // The loose document is neither a skill nor claimed by one.
  assert.equal(result.fileCount, 5)
  assert.ok(result.skills[0].files.some((file) => file.path === 'reference/notes.md'))
}

function noNestedSkills(): void {
  const entries: SkillTreeEntry[] = [
    { path: 'prototype/SKILL.md', mode: '100644', type: 'blob', sha: 'a', size: 1 },
    { path: 'prototype/agents/openai.yaml', mode: '100644', type: 'blob', sha: 'b', size: 1 },
    { path: 'prototype/nested/SKILL.md', mode: '100644', type: 'blob', sha: 'c', size: 1 },
  ]
  const result = scanSkillTree({ entries, commitSha: 'sha' })
  assert.deepEqual(
    result.skills.map((skill) => skill.id),
    ['prototype'],
    'the walk stops at the first hit — a skill cannot nest a skill'
  )
  assert.equal(result.skills[0].files.length, 3)
}

function symlinksAreNotSkillFiles(): void {
  const entries: SkillTreeEntry[] = [
    { path: 'skills/alpha/SKILL.md', mode: '100644', type: 'blob', sha: 'a', size: 1 },
    { path: 'skills/alpha/AGENTS.md', mode: '120000', type: 'blob', sha: 'b', size: 9 },
    { path: 'skills/alpha/run.sh', mode: '100755', type: 'blob', sha: 'c', size: 3 },
  ]
  const result = scanSkillTree({ entries, commitSha: 'sha' })
  assert.deepEqual(
    result.skills[0].files.map((file) => file.path),
    ['SKILL.md', 'run.sh']
  )
  assert.equal(result.skills[0].hasExecutables, true)
}

function mirrorsCollapseOntoTheCopyOutsideAHarnessRoot(): void {
  const entry = (path: string, sha: string): SkillTreeEntry => ({
    path,
    mode: '100644',
    type: 'blob',
    sha,
    size: 1,
  })
  const result = scanSkillTree({
    commitSha: 'sha',
    entries: [
      entry('skills/alpha/SKILL.md', 'a'),
      entry('skills/alpha/reference/notes.md', 'b'),
      // Same skill, republished for two harnesses, with harness paths rewritten
      // into the prose so no two copies share a blob SHA.
      entry('.claude/skills/alpha/SKILL.md', 'c'),
      entry('.cursor/skills/alpha/SKILL.md', 'd'),
      entry('skills/beta/SKILL.md', 'e'),
    ],
  })
  assert.deepEqual(
    result.skills.map((skill) => skill.id),
    ['skills/alpha', 'skills/beta'],
    'the copy outside a harness root is the canonical one'
  )
  assert.equal(result.skills[0].files.length, 2)
}

function repoRootSkill(): void {
  const entries: SkillTreeEntry[] = [
    { path: 'SKILL.md', mode: '100644', type: 'blob', sha: 'a', size: 1 },
    { path: 'reference/notes.md', mode: '100644', type: 'blob', sha: 'b', size: 1 },
  ]
  const result = scanSkillTree({ entries, commitSha: 'sha' })
  assert.deepEqual(result.skills.map((skill) => skill.id), [''])
  assert.equal(result.skills[0].files.length, 2)
  assert.equal(result.skills[0].group, '')
}

function main(): void {
  mattpocock()
  anthropics()
  manifestGroupingIsAdditive()
  browserAct()
  impeccable()
  nonSkillDocuments()
  noNestedSkills()
  symlinksAreNotSkillFiles()
  mirrorsCollapseOntoTheCopyOutsideAHarnessRoot()
  repoRootSkill()
  console.log('skills scan: ok')
}

main()
