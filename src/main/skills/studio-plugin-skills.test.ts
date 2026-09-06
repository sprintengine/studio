// The plugin's skills, read the way every harness reads them.
//
// A skill an agent cannot load is a skill that does not exist, and the two ways
// to make one are silent: a `name` that does not match the directory (the
// harness looks it up by directory and finds a document calling itself
// something else) and a description that says WHAT rather than WHEN (the agent
// never invokes it, because loading by name and description until used is the
// whole point). Both are checked here against the app's own parser.

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { parseSkillFrontmatter, SKILL_ENTRY_FILE } from '../../shared/skills'
import { STUDIO_PLUGIN_ID } from './studio-plugin'

const SKILLS_ROOT = resolve(__dirname, '..', '..', '..', 'resources', 'studio-plugin', STUDIO_PLUGIN_ID, 'skills')

/** The Agent Skills specification's ceiling on a description. */
const MAX_DESCRIPTION_LENGTH = 1024
/** The specification's guidance on how long a body may run before it splits. */
const MAX_BODY_LINES = 500

/** The five areas the item names. A sixth is fine; a missing one is not. */
const REQUIRED_AREAS = [
  'studio-sprints',
  'studio-backlog',
  'studio-automations',
  'studio-workspaces',
  'studio-review',
]

async function main(): Promise<void> {
  const entries = await readdir(SKILLS_ROOT, { withFileTypes: true })
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()

  for (const area of REQUIRED_AREAS) {
    assert.equal(dirs.includes(area), true, `the plugin must ship a ${area} skill`)
  }

  for (const dirName of dirs) {
    const path = join(SKILLS_ROOT, dirName, SKILL_ENTRY_FILE)
    const raw = await readFile(path, 'utf8')
    const parsed = parseSkillFrontmatter(raw)

    assert.equal(
      parsed.name,
      dirName,
      `${dirName}/${SKILL_ENTRY_FILE}: "name" must equal its directory, and reads "${parsed.name}"`
    )
    assert.notEqual(parsed.description, '', `${dirName}: a skill with no description is never loaded`)
    assert.equal(
      parsed.description.length <= MAX_DESCRIPTION_LENGTH,
      true,
      `${dirName}: description is ${parsed.description.length} characters, over the ${MAX_DESCRIPTION_LENGTH} limit`
    )
    // "Use when …" is the sentence that makes a description an invocation
    // trigger rather than a summary of what the skill contains.
    assert.match(parsed.description, /\bUse when\b/, `${dirName}: the description must say WHEN to use the skill`)

    const lines = raw.split(/\r?\n/).length
    assert.equal(lines <= MAX_BODY_LINES, true, `${dirName}: ${lines} lines, over the ${MAX_BODY_LINES} limit`)

    // The frontmatter block must terminate: an unterminated one parses to
    // nothing and the assertions above would have caught it, but the failure
    // would read as "name is empty" rather than as the malformed file it is.
    assert.match(raw, /^---\r?\n[\s\S]*?\r?\n---\r?\n/, `${dirName}: frontmatter is not a terminated --- block`)

    // A description carrying a raw newline breaks the flat-scalar reading every
    // harness (and this app's own reader) does.
    const descriptionLine = raw.split(/\r?\n/).find((line) => line.startsWith('description:')) ?? ''
    assert.equal(
      descriptionLine.slice('description:'.length).trim().length > 0,
      true,
      `${dirName}: "description" must be an inline scalar, not a folded block`
    )
  }

  console.log(`studio plugin skills: ok (${dirs.length})`)
}

void main()
