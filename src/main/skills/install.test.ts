import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ScannedSkill, SkillFileRef } from '../../shared/skills'
import {
  installSkill,
  installSkillDirectory,
  PLUGIN_BUNDLE_SKILL_SOURCE_ID,
  planSkillInstall,
  readSkillProvenance,
  resolveSkillFilePath,
  SKILL_PROVENANCE_FILE,
  uninstallSkill,
} from './install'
import { scanLocalSkillSource } from './local-source'
import { test } from 'vitest'

test('install', async () => {
  const PROVENANCE = { sourceId: 'github:acme/skills', skillId: 'skills/prototype', commitSha: 'b81f77a' }

  function file(path: string): SkillFileRef {
    return { path, size: 1, blobSha: '', isEntry: path === 'SKILL.md' }
  }

  function skill(paths: string[], id = 'skills/prototype'): ScannedSkill {
    return {
      id,
      name: 'prototype',
      description: '',
      group: '',
      files: paths.map(file),
      allowedTools: [],
      hasExecutables: false,
    }
  }

  const CONTENT = (path: string): Buffer => Buffer.from(`content of ${path}\n`, 'utf8')

  async function installsWholeDirectory(): Promise<void> {
    const workspace = await mkdtemp(join(tmpdir(), 'sprintengine-skill-install-'))
    const paths = [
      'SKILL.md',
      'agents/openai.yaml',
      'scripts/context.mjs',
      'reference/craft-floor.md',
      'reference/nested/deep.md',
    ]
    const result = await installSkill({
      workspaceRoot: workspace,
      skill: skill(paths),
      harnesses: ['agents', 'claude'],
      readFile: async (target) => CONTENT(target.path),
      provenance: PROVENANCE,
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.dirName, 'prototype')
    assert.equal(result.fileCount, 5)
    assert.deepEqual(result.harnesses, ['agents', 'claude'])

    for (const harnessDir of ['.agents', '.claude']) {
      const root = join(workspace, harnessDir, 'skills', 'prototype')
      for (const path of paths) {
        const contents = await readFile(join(root, ...path.split('/')), 'utf8')
        assert.equal(contents, `content of ${path}\n`, `${harnessDir}/${path} must land with its bytes`)
      }
      // Subdirectory shape survives — agents/, scripts/ and reference/ are
      // directories at the destination, not flattened filenames.
      for (const dir of ['agents', 'scripts', 'reference', join('reference', 'nested')]) {
        assert.equal((await stat(join(root, dir))).isDirectory(), true, `${harnessDir}/${dir}`)
      }
      assert.deepEqual(
        (await readdir(root)).sort(),
        [SKILL_PROVENANCE_FILE, 'SKILL.md', 'agents', 'reference', 'scripts'],
        'the copy carries the provenance marker alongside the skill it installed',
      )
      assert.deepEqual(await readSkillProvenance(root), PROVENANCE)
    }
  }

  async function reinstallReplacesRatherThanMerges(): Promise<void> {
    const workspace = await mkdtemp(join(tmpdir(), 'sprintengine-skill-reinstall-'))
    const install = (paths: string[]): Promise<unknown> =>
      installSkill({
        workspaceRoot: workspace,
        skill: skill(paths),
        harnesses: ['agents'],
        readFile: async (target) => CONTENT(target.path),
        provenance: PROVENANCE,
      })
    await install(['SKILL.md', 'reference/old.md'])
    await install(['SKILL.md', 'reference/new.md'])
    const reference = join(workspace, '.agents', 'skills', 'prototype', 'reference')
    assert.deepEqual(
      await readdir(reference),
      ['new.md'],
      'a file the skill no longer ships must not survive a reinstall',
    )
  }

  async function rejectsEscapingPaths(): Promise<void> {
    const workspace = await mkdtemp(join(tmpdir(), 'sprintengine-skill-escape-'))
    const escapes = [
      '../../.claude/settings.json',
      'reference/../../../evil.md',
      '/etc/passwd',
      'agents\\..\\..\\evil.yaml',
      '',
    ]
    for (const path of escapes) {
      const planned = planSkillInstall(workspace, skill(['SKILL.md', path]), ['agents'])
      assert.equal(planned.ok, false, `planning must refuse ${JSON.stringify(path)}`)

      let read = 0
      const result = await installSkill({
        workspaceRoot: workspace,
        skill: skill(['SKILL.md', path]),
        harnesses: ['agents'],
        readFile: async (target) => {
          read += 1
          return CONTENT(target.path)
        },
        provenance: PROVENANCE,
      })
      assert.equal(result.ok, false, `installing must refuse ${JSON.stringify(path)}`)
      assert.equal(read, 0, 'a refused install must not fetch a single byte')
    }
    // Nothing was written anywhere — the whole install is refused, not sanitised.
    await assert.rejects(() => stat(join(workspace, '.agents')))
  }

  function resolvesOnlyInsideTheSkill(): void {
    const target = join(tmpdir(), 'skill-target')
    assert.equal(resolveSkillFilePath(target, 'SKILL.md'), join(target, 'SKILL.md'))
    assert.equal(resolveSkillFilePath(target, 'a/b/c.md'), join(target, 'a', 'b', 'c.md'))
    assert.equal(resolveSkillFilePath(target, 'a/./b.md'), null)
    assert.equal(resolveSkillFilePath(target, '../escape.md'), null)
    assert.equal(resolveSkillFilePath(target, 'a/../../escape.md'), null)
    assert.equal(resolveSkillFilePath(target, 'a\\b.md'), null)
    assert.equal(resolveSkillFilePath(target, 'a\0b.md'), null)
    assert.equal(resolveSkillFilePath(target, ''), null)
  }

  async function refusesWithoutAHarness(): Promise<void> {
    const workspace = await mkdtemp(join(tmpdir(), 'sprintengine-skill-noharness-'))
    const result = await installSkill({
      workspaceRoot: workspace,
      skill: skill(['SKILL.md']),
      harnesses: [],
      readFile: async () => Buffer.alloc(0),
      provenance: PROVENANCE,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /No agent CLI/)
  }

  // A skill that is already a directory on this machine — a plugin bundle's skill
  // component — installs by the same copy, subdirectories and all.
  async function installsALocalDirectory(): Promise<void> {
    const temp = await mkdtemp(join(tmpdir(), 'sprintengine-skill-localdir-'))
    const workspace = join(temp, 'ws')
    const source = join(temp, 'bundle', 'my-skill')
    await mkdir(workspace, { recursive: true })
    await mkdir(join(source, 'scripts'), { recursive: true })
    await writeFile(join(source, 'SKILL.md'), '---\nname: my-skill\n---\n')
    await writeFile(join(source, 'scripts', 'run.sh'), 'echo hi\n')

    const result = await installSkillDirectory({
      workspaceRoot: workspace,
      sourceDir: source,
      dirName: 'my-skill',
      harnesses: ['agents', 'claude'],
    })
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.deepEqual(result.harnesses, ['agents', 'claude'])
    assert.equal(result.fileCount, 2)
    assert.ok(
      existsSync(join(workspace, '.agents', 'skills', 'my-skill', 'scripts', 'run.sh')),
      'subdirectories survive',
    )
    assert.ok(existsSync(join(workspace, '.claude', 'skills', 'my-skill', 'SKILL.md')), 'every harness gets a copy')

    // A bundle is not a skill source, so the copy names one no source sync can
    // match — and the marker was written into the copy, never back into the
    // bundle the bytes were read from.
    assert.deepEqual(await readSkillProvenance(join(workspace, '.agents', 'skills', 'my-skill')), {
      sourceId: PLUGIN_BUNDLE_SKILL_SOURCE_ID,
      skillId: 'my-skill',
      commitSha: '',
    })
    assert.equal(await readSkillProvenance(source), null, 'the source directory is left exactly as it was')

    const empty = await installSkillDirectory({
      workspaceRoot: workspace,
      sourceDir: join(temp, 'bundle', 'nothing-here'),
      dirName: 'nothing-here',
      harnesses: ['agents'],
    })
    assert.equal(empty.ok, false, 'a directory with no files is refused, not silently installed')
  }

  // Removal sweeps every harness that could hold a copy: one left behind is a
  // skill the user believes they removed and an agent still reads.
  async function uninstallSweepsEveryHarness(): Promise<void> {
    const temp = await mkdtemp(join(tmpdir(), 'sprintengine-skill-uninstall-'))
    const workspace = join(temp, 'ws')
    const source = join(temp, 'my-skill')
    await mkdir(workspace, { recursive: true })
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), '---\nname: my-skill\n---\n')
    await installSkillDirectory({
      workspaceRoot: workspace,
      sourceDir: source,
      dirName: 'my-skill',
      harnesses: ['agents', 'claude'],
    })

    const removed = await uninstallSkill({
      workspaceRoot: workspace,
      dirName: 'my-skill',
      // Includes a harness that never held a copy: it must not be reported as one
      // this call cleaned up.
      harnesses: ['agents', 'claude', 'codex'],
    })
    assert.equal(removed.ok, true)
    if (!removed.ok) return
    assert.equal(removed.removedPaths.length, 2, 'only the harnesses that held a copy are reported')
    assert.ok(!existsSync(join(workspace, '.agents', 'skills', 'my-skill')))
    assert.ok(!existsSync(join(workspace, '.claude', 'skills', 'my-skill')))
    // The provenance marker goes with the directory. One left behind would claim
    // a source still owns a skill that is no longer installed.
    for (const harnessDir of ['.agents', '.claude']) {
      assert.ok(!existsSync(join(workspace, harnessDir, 'skills', 'my-skill', SKILL_PROVENANCE_FILE)))
    }

    // Already gone is an empty sweep, not a failure — each caller decides what
    // that means to it.
    const again = await uninstallSkill({ workspaceRoot: workspace, dirName: 'my-skill', harnesses: ['agents'] })
    assert.equal(again.ok, true)
    if (again.ok) assert.deepEqual(again.removedPaths, [])

    // A name that is not one path segment is refused outright, never resolved
    // and quietly found to point outside the workspace.
    for (const dirName of ['../../etc', 'a/b', '..', '']) {
      const refused = await uninstallSkill({ workspaceRoot: workspace, dirName, harnesses: ['agents'] })
      assert.equal(refused.ok, false, `"${dirName}" is refused by name`)
    }
  }

  // The marker is written into the installed copy and never into the source the
  // bytes came from, so it cannot reach the file list the skill reader renders —
  // the list is the scan's, and the scan reads the source.
  async function theProvenanceMarkerStaysOutOfTheReadersFileList(): Promise<void> {
    const temp = await mkdtemp(join(tmpdir(), 'sprintengine-skill-reader-'))
    const workspace = join(temp, 'ws')
    const sourceRoot = join(temp, 'source')
    await mkdir(workspace, { recursive: true })
    await mkdir(join(sourceRoot, 'writer'), { recursive: true })
    // A description because a skill without one is not a skill and the scan drops
    // it (https://agentskills.io/specification, fetched 2026-09-06).
    await writeFile(join(sourceRoot, 'writer', 'SKILL.md'), '---\nname: writer\ndescription: Writes.\n---\n')

    const before = await scanLocalSkillSource(sourceRoot)
    await installSkillDirectory({
      workspaceRoot: workspace,
      sourceDir: join(sourceRoot, 'writer'),
      dirName: 'writer',
      harnesses: ['agents'],
    })
    const after = await scanLocalSkillSource(sourceRoot)

    for (const scan of [before, after]) {
      assert.deepEqual(
        scan.skills.map((entry) => entry.files.map((skillFile) => skillFile.path)),
        [['SKILL.md']],
        'the source lists the skill it holds, and the marker is not one of its files',
      )
    }
    assert.ok(existsSync(join(workspace, '.agents', 'skills', 'writer', SKILL_PROVENANCE_FILE)))
  }

  /**
   * A folder source reads the same specification as a repository: a directory
   * whose SKILL.md declares no description is not a skill, and the scan says how
   * many it passed over (https://agentskills.io/specification, fetched
   * 2026-09-06).
   */
  async function aLocalEntryWithNoDescriptionIsSkippedAndCounted(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'sprintengine-skill-nodesc-'))
    for (const name of ['keeper', 'nameless', 'empty']) {
      await mkdir(join(root, name), { recursive: true })
    }
    await writeFile(join(root, 'keeper', 'SKILL.md'), '---\nname: keeper\ndescription: Keeps things.\n---\n')
    await writeFile(join(root, 'nameless', 'SKILL.md'), '---\nname: nameless\n---\n# No description\n')
    // A zero-byte entry document was READ, and declares no description.
    await writeFile(join(root, 'empty', 'SKILL.md'), '')

    const scan = await scanLocalSkillSource(root)
    assert.deepEqual(
      scan.skills.map((entry) => entry.id),
      ['keeper'],
    )
    assert.equal(scan.skippedNoDescription, 2)
    assert.equal(scan.fileCount, 1, 'the skipped directories take their files with them')
  }

  async function main(): Promise<void> {
    await installsWholeDirectory()
    await reinstallReplacesRatherThanMerges()
    await rejectsEscapingPaths()
    resolvesOnlyInsideTheSkill()
    await refusesWithoutAHarness()
    await installsALocalDirectory()
    await theProvenanceMarkerStaysOutOfTheReadersFileList()
    await aLocalEntryWithNoDescriptionIsSkippedAndCounted()
    await uninstallSweepsEveryHarness()
    console.log('skills install: ok')
  }

  const suiteRun = main()

  await suiteRun
})
