import assert from 'node:assert/strict'

import {
  parseSkillFragment,
  parseSkillFrontmatter,
  skillDirName,
  skillNameWarning,
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
    license: '',
    compatibility: '',
    metadata: {},
  })

  // A folded description carries its text below the marker. Reading the marker
  // as the value is how a catalogue row came to show ">" where its one line of
  // description belongs — 1,723 of them, on the connector source's tab.
  const folded = parseSkillFrontmatter(
    '---\nname: 42crunch-audit\ndescription: >\n  Audit an OpenAPI file for security issues\n  and report what it found.\nallowed-tools: Read\n---\n',
  )
  assert.equal(folded.name, '42crunch-audit')
  assert.equal(folded.description, 'Audit an OpenAPI file for security issues and report what it found.')
  assert.deepEqual(folded.allowedTools, ['Read'])

  // A literal block folds the same way; the marker itself is never the value.
  assert.equal(
    parseSkillFrontmatter('---\ndescription: |\n  One line.\n---\n').description,
    'One line.',
  )
}

/**
 * The specification's own `allowed-tools` example. It is a SPACE-separated
 * string (https://agentskills.io/specification, fetched 2026-09-06); splitting
 * it on commas — which is what this did until 2026-09-06 — collapsed three
 * tools into one bogus name, `Bash(git:*) Bash(jq:*) Read`.
 */
function allowedToolsIsSpaceSeparated(): void {
  const spec = parseSkillFrontmatter(
    ['---', 'name: git-helper', 'description: Helps.', 'allowed-tools: Bash(git:*) Bash(jq:*) Read', '---'].join('\n'),
  )
  assert.deepEqual(spec.allowedTools, ['Bash(git:*)', 'Bash(jq:*)', 'Read'])

  // A space inside a tool's own argument pattern is not a separator.
  assert.deepEqual(
    parseSkillFrontmatter('---\nallowed-tools: Bash(npx impeccable *) Read\n---\n').allowedTools,
    ['Bash(npx impeccable *)', 'Read'],
  )
  // Nor is one inside quotes.
  assert.deepEqual(
    parseSkillFrontmatter('---\nallowed-tools: "my tool" Read\n---\n').allowedTools,
    ['my tool', 'Read'],
  )
  // The comma-separated form Claude Code's own documentation used still reads,
  // including the mixed form a repository ends up with.
  assert.deepEqual(
    parseSkillFrontmatter('---\nallowed-tools: Read, Write Bash\n---\n').allowedTools,
    ['Read', 'Write', 'Bash'],
  )
  // An apostrophe inside a command is not an opening quote. Treating it as one
  // swallowed the rest of the line into a single bogus tool name — the very
  // failure splitting on whitespace was meant to end.
  assert.deepEqual(
    parseSkillFrontmatter("---\nallowed-tools: Bash(don't:*) Read Write\n---\n").allowedTools,
    ["Bash(don't:*)", 'Read', 'Write'],
  )
}

/**
 * A byte-order mark sits before the opening fence, so a SKILL.md saved by a
 * Windows editor used to parse to nothing at all — and since a skill with no
 * description is skipped, that would delete the skill from its source's listing
 * over three invisible bytes.
 */
function byteOrderMarkedFrontmatter(): void {
  const bom = '\uFEFF'
  const parsed = parseSkillFrontmatter(
    `${bom}---\nname: writer\ndescription: Writes things.\nallowed-tools: Read Write\n---\n# Writer\n`,
  )
  assert.equal(parsed.name, 'writer')
  assert.equal(parsed.description, 'Writes things.')
  assert.deepEqual(parsed.allowedTools, ['Read', 'Write'])
  // The same three bytes in a code-search fragment, which has no fence at all.
  assert.equal(parseSkillFragment(`${bom}name: writer\ndescription: Writes things.\n`).name, 'writer')
}

/** The three optional fields the specification defines, and the app ignored. */
function optionalSpecFields(): void {
  const full = parseSkillFrontmatter(
    [
      '---',
      'name: pdf-processing',
      'description: Extract PDF text, fill forms, merge files.',
      'license: Proprietary. LICENSE.txt has complete terms',
      'compatibility: Requires git, docker, jq, and access to the internet',
      'metadata:',
      '  author: example-org',
      '  version: "1.0"',
      '---',
      '',
      '# Body',
    ].join('\n'),
  )
  assert.equal(full.license, 'Proprietary. LICENSE.txt has complete terms')
  assert.equal(full.compatibility, 'Requires git, docker, jq, and access to the internet')
  assert.deepEqual(full.metadata, { author: 'example-org', version: '1.0' })

  // A folded license or compatibility block reads like every other folded
  // scalar, and a flow map is still a map.
  const folded = parseSkillFrontmatter(
    ['---', 'compatibility: >', '  Designed for Claude Code', '  (or similar products)', 'metadata: {author: acme}', '---'].join('\n'),
  )
  assert.equal(folded.compatibility, 'Designed for Claude Code (or similar products)')
  assert.deepEqual(folded.metadata, { author: 'acme' })

  // A nested value under `metadata` is not four more top-level keys: the map is
  // string to string, and reading the deeper lines invented rows stating
  // nothing. The entries at the map's own indent still read.
  const nested = parseSkillFrontmatter(
    [
      '---',
      'name: alpha',
      'description: A skill.',
      'metadata:',
      '  author: example-org',
      '  contact:',
      '    email: nobody@example.com',
      '  version: "2"',
      '---',
    ].join('\n'),
  )
  assert.deepEqual(nested.metadata, { author: 'example-org', contact: '', version: '2' })

  // A skill that declares none of them says so with blanks, never with copy
  // invented from the fields it did declare.
  const bare = parseSkillFrontmatter('---\nname: alpha\ndescription: A skill.\n---\n')
  assert.equal(bare.license, '')
  assert.equal(bare.compatibility, '')
  assert.deepEqual(bare.metadata, {})
}

/** `name`, against the specification's own valid and invalid examples. */
function nameValidation(): void {
  assert.equal(skillNameWarning('pdf-processing', 'pdf-processing'), '')
  assert.equal(skillNameWarning('data-analysis', 'data-analysis'), '')
  assert.equal(skillNameWarning('code-review', 'code-review'), '')

  // Nothing declared is nothing to warn about: an unread entry keeps its
  // directory name, which is not a claim about its frontmatter.
  assert.equal(skillNameWarning('', 'anything'), '')
  // A skill at a source's root has no directory to match, and the other rules
  // still apply to it.
  assert.equal(skillNameWarning('impeccable', ''), '')

  assert.match(skillNameWarning('PDF-Processing', 'PDF-Processing'), /lowercase letters/)
  assert.match(skillNameWarning('-pdf', '-pdf'), /hyphen/)
  assert.match(skillNameWarning('pdf-', 'pdf-'), /hyphen/)
  assert.match(skillNameWarning('pdf--processing', 'pdf--processing'), /doubled hyphen/)
  assert.match(skillNameWarning('a'.repeat(65), 'a'.repeat(65)), /65 characters/)
  assert.equal(skillNameWarning('a'.repeat(64), 'a'.repeat(64)), '')

  // "Unicode lowercase alphanumeric" is what the specification says, so a name
  // outside ASCII is conformant as long as it is not upper case.
  assert.equal(skillNameWarning('café-export', 'café-export'), '')
  assert.match(skillNameWarning('Café-Export', 'Café-Export'), /lowercase letters/)
  assert.match(skillNameWarning('pdf processing', 'pdf processing'), /lowercase letters/)

  // The case anthropics/skills ships: `template/` declares `template-skill`.
  assert.match(skillNameWarning('template-skill', 'template'), /directory name “template”/)
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
  allowedToolsIsSpaceSeparated()
  byteOrderMarkedFrontmatter()
  optionalSpecFields()
  nameValidation()
  identifiers()
  console.log('shared skills: ok')
}

main()
