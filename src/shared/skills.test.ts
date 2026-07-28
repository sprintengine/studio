import assert from 'node:assert/strict'

import {
  parseSkillFrontmatter,
  skillDirName,
  skillSourceMonogram,
  sourceLayout,
  type ScanResult,
  type ScannedSkill,
} from './skills'

function skills(count: number): ScannedSkill[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `skills/skill-${index}`,
    name: `skill-${index}`,
    description: '',
    group: '',
    files: [],
    allowedTools: [],
    hasExecutables: false,
  }))
}

function result(count: number, grouped: boolean): ScanResult {
  return {
    skills: skills(count),
    groups: grouped ? ['one', 'two'] : [],
    groupingSignal: grouped ? 'folders' : 'none',
    fileCount: 0,
    commitSha: '',
  }
}

function layoutBoundaries(): void {
  assert.equal(sourceLayout(result(0, false)), 'none')
  assert.equal(sourceLayout(result(0, true)), 'none')

  // One skill is one skill however the source groups it.
  assert.equal(sourceLayout(result(1, false)), 'solo')
  assert.equal(sourceLayout(result(1, true)), 'solo')

  // Ungrouped stays a flat list to 24, then search takes over — the gap the
  // backlog table left open at 25-59 lands on search-first, not on grouping a
  // source that carries no groups.
  assert.equal(sourceLayout(result(2, false)), 'flat')
  assert.equal(sourceLayout(result(24, false)), 'flat')
  assert.equal(sourceLayout(result(25, false)), 'search')
  assert.equal(sourceLayout(result(60, false)), 'search')
  assert.equal(sourceLayout(result(61, false)), 'search')

  // Grouped stays browsable much further, because the groups do the narrowing.
  assert.equal(sourceLayout(result(2, true)), 'grouped')
  assert.equal(sourceLayout(result(24, true)), 'grouped')
  assert.equal(sourceLayout(result(25, true)), 'grouped')
  assert.equal(sourceLayout(result(60, true)), 'grouped')
  assert.equal(sourceLayout(result(61, true)), 'search')

  // A signal with no groups behind it is not a grouped source.
  assert.equal(
    sourceLayout({ ...result(30, true), groups: [] }),
    'search',
    'grouping needs actual groups, not just a signal'
  )
}

function frontmatter(): void {
  const block = parseSkillFrontmatter(
    [
      '---',
      'name: impeccable',
      'description: "Design work that earns its keep"',
      'version: 4.0.3',
      'allowed-tools:',
      '  - Bash(npx impeccable *)',
      '  - Read',
      '---',
      '',
      '# Body',
      'name: not-frontmatter',
    ].join('\n')
  )
  assert.equal(block.name, 'impeccable')
  assert.equal(block.description, 'Design work that earns its keep')
  assert.deepEqual(block.allowedTools, ['Bash(npx impeccable *)', 'Read'])

  const inline = parseSkillFrontmatter(
    ['---', "name: 'alpha'", 'allowed-tools: Read, Write, Bash', '---', 'body'].join('\n')
  )
  assert.deepEqual(inline.allowedTools, ['Read', 'Write', 'Bash'])
  assert.equal(inline.name, 'alpha')
  assert.equal(inline.description, '')

  const bracketed = parseSkillFrontmatter(
    ['---', 'allowed-tools: [Read, "Bash(ls)"]', '---'].join('\n')
  )
  assert.deepEqual(bracketed.allowedTools, ['Read', 'Bash(ls)'])

  // No frontmatter, and a body that merely looks like it, disclose nothing.
  assert.deepEqual(parseSkillFrontmatter('# Just a heading\nname: nope\n'), {
    name: '',
    description: '',
    allowedTools: [],
  })
}

function identifiers(): void {
  assert.equal(skillDirName('solutions/ecommerce/amazon-alexa-qa'), 'amazon-alexa-qa')
  assert.equal(skillDirName('prototype'), 'prototype')
  assert.equal(skillDirName(''), '')
  assert.equal(skillSourceMonogram('impeccable'), 'IM')
  assert.equal(skillSourceMonogram('browser-act skills'), 'BA')
  assert.equal(skillSourceMonogram(''), '?')
}

function main(): void {
  layoutBoundaries()
  frontmatter()
  identifiers()
  console.log('shared skills: ok')
}

main()
