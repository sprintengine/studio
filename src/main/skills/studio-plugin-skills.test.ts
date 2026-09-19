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
import { createAutomationTools } from '../automation/automation-tools'
import { createBrowserTools } from '../automation/browser-tools'
import { createCanvasTools } from '../automation/canvas-tools'
import { createTailnetTools } from '../automation/tailnet/tailnet-tools'
import { STUDIO_PLUGIN_ID } from './studio-plugin'
import { test } from 'vitest'

test('studio-plugin-skills', async () => {
  // Bundled into node_modules/.cache before it runs, so `__dirname` says nothing
  // about where the source lives; `npm run` sets the cwd to the package root.
  const SKILLS_ROOT = resolve(process.cwd(), 'resources', 'studio-plugin', STUDIO_PLUGIN_ID, 'skills')

  /** The Agent Skills specification's ceiling on a description. */
  const MAX_DESCRIPTION_LENGTH = 1024
  /** The specification's guidance on how long a body may run before it splits. */
  const MAX_BODY_LINES = 500

  /** The areas the item names. One more is fine; a missing one is not. */
  const REQUIRED_AREAS = ['studio-backlog', 'studio-automations', 'studio-canvas', 'studio-workspaces']

  /**
   * Backticked snake_case words the skills use that are NOT tool names — statuses,
   * option values, error codes, a directory. Anything else in backticks shaped
   * like `family_verb` is read as a tool the skill tells an agent to call.
   */
  const NON_TOOL_TOKENS = new Set([
    'bypass_all',
    'canvas_module_disabled',
    'in_progress',
    // A canvas error code, not a tool: the board file on disk is unreadable, so
    // nothing was written over it.
    'invalid_scene',
    'needs_input',
    'node_modules',
    'not_found',
    'project_root_required',
    'too_large',
  ])

  /**
   * Tool families that no longer exist. A bare mention of one (outside
   * backticks) still counts, because the removed sprint skill named its tools in
   * prose as often as in code spans.
   */
  const RETIRED_TOOL_FAMILIES = ['sprint', 'sprintengine']

  /**
   * The tool names the app's MCP server registers, in the form an agent sees
   * them: the server's `workspace.create` reaches a harness as `workspace_create`.
   * The factories are built with no backends — only the registrations' names are
   * read, and no handler runs.
   */
  function registeredToolNames(): Set<string> {
    const registrations = [
      ...createAutomationTools({} as never),
      ...createBrowserTools({} as never),
      ...createCanvasTools({} as never),
      ...createTailnetTools({ resolveTailnet: () => null }),
    ]
    return new Set(registrations.map((registration) => registration.name.replace(/\./g, '_')))
  }

  /**
   * Every tool a shipped skill mentions must be one the server registers. The
   * sprint tools were deleted while `studio-sprints` and two other skills still
   * told agents to call them or to read what they returned; this is the check
   * that would have caught it.
   */
  async function everyToolASkillNamesIsRegistered(dirs: string[]): Promise<void> {
    const registered = registeredToolNames()
    assert.equal(registered.has('workspace_create'), true, 'the registered names are read in their harness form')
    assert.equal(registered.has('browser_open'), true)
    assert.equal(registered.has('canvas_edit'), true)
    assert.equal(registered.has('tailnet_status'), true)
    const families = new Set([...registered].map((name) => name.split('_')[0]))
    for (const family of RETIRED_TOOL_FAMILIES) families.add(family)
    const bareMention = new RegExp(`\\b(?:${[...families].join('|')})_[a-z_]*[a-z]\\b`, 'g')
    for (const dirName of dirs) {
      const raw = await readFile(join(SKILLS_ROOT, dirName, SKILL_ENTRY_FILE), 'utf8')
      const mentioned = new Set<string>()
      for (const match of raw.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
        if (!NON_TOOL_TOKENS.has(match[1])) mentioned.add(match[1])
      }
      for (const match of raw.matchAll(bareMention)) {
        // The same allow-list as above: this sweep reads the raw file, so a
        // backticked error code is seen here too and must not read as a tool.
        if (!NON_TOOL_TOKENS.has(match[0])) mentioned.add(match[0])
      }
      for (const name of mentioned) {
        assert.equal(
          registered.has(name),
          true,
          `${dirName}/${SKILL_ENTRY_FILE} names \`${name}\`, which the Studio MCP server does not register. ` +
            'Fix the skill, or add the word to NON_TOOL_TOKENS if it is not a tool.',
        )
      }
    }
  }

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
        `${dirName}/${SKILL_ENTRY_FILE}: "name" must equal its directory, and reads "${parsed.name}"`,
      )
      assert.notEqual(parsed.description, '', `${dirName}: a skill with no description is never loaded`)
      assert.equal(
        parsed.description.length <= MAX_DESCRIPTION_LENGTH,
        true,
        `${dirName}: description is ${parsed.description.length} characters, over the ${MAX_DESCRIPTION_LENGTH} limit`,
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
        `${dirName}: "description" must be an inline scalar, not a folded block`,
      )
    }

    await everyToolASkillNamesIsRegistered(dirs)

    console.log(`studio plugin skills: ok (${dirs.length})`)
  }

  const suiteRun = main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
