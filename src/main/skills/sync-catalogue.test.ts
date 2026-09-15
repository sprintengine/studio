// `npm run sync:catalogue` pulls published `workflow-roles` into the bundled
// seed and leaves `sprintengine-studio` (and a local `studio-skills` listing)
// untouched. `--from` is the test seam: a local checkout instead of GitHub.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const REPO_ROOT = resolve(process.cwd())
const SCRIPT = join(REPO_ROOT, 'scripts', 'sync-catalogue.mjs')

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  const from = await mkdtemp(join(tmpdir(), 'sync-catalogue-from-'))
  const root = await mkdtemp(join(tmpdir(), 'sync-catalogue-root-'))

  await writeJson(join(from, '.claude-plugin', 'marketplace.json'), {
    name: 'sprintengine-studio',
    plugins: [
      {
        name: 'sprintengine-studio',
        source: './sprintengine-studio',
        description: 'Drive SprintEngine Studio from an agent.',
        version: '1.0.0',
      },
      {
        name: 'workflow-roles',
        source: './workflow-roles',
        description: 'The sixteen Sprint Engine workflow roles.',
        version: '1.0.1',
      },
      {
        name: 'studio-skills',
        source: './studio-skills',
        description: 'Must not be re-added.',
        version: '9.9.9',
      },
    ],
  })
  await mkdir(join(from, 'workflow-roles', '.claude-plugin'), { recursive: true })
  await writeFile(
    join(from, 'workflow-roles', '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'workflow-roles', version: '1.0.1' }, null, 2)}\n`,
    'utf8',
  )
  await mkdir(join(from, 'workflow-roles', 'skills', 'architect'), { recursive: true })
  await writeFile(join(from, 'workflow-roles', 'skills', 'architect', 'SKILL.md'), '---\nname: architect\n---\npublished\n', 'utf8')
  await mkdir(join(from, 'sprintengine-studio'), { recursive: true })
  await writeFile(join(from, 'sprintengine-studio', 'POISON.txt'), 'must not land\n', 'utf8')
  await mkdir(join(from, 'studio-skills', 'skills', 'frontend-design'), { recursive: true })
  await writeFile(join(from, 'studio-skills', 'skills', 'frontend-design', 'SKILL.md'), 'retired\n', 'utf8')

  await writeJson(join(root, 'resources', 'studio-plugin', '.claude-plugin', 'marketplace.json'), {
    name: 'sprintengine-studio',
    plugins: [
      { name: 'sprintengine-studio', source: './sprintengine-studio', description: 'ours', version: '1.0.0' },
      { name: 'studio-skills', source: './studio-skills', description: 'local listing', version: '1.0.0' },
      { name: 'workflow-roles', source: './workflow-roles', description: 'stale', version: '1.0.0' },
    ],
  })
  await mkdir(join(root, 'resources', 'studio-plugin', 'sprintengine-studio'), { recursive: true })
  await writeFile(join(root, 'resources', 'studio-plugin', 'sprintengine-studio', 'KEEP.txt'), 'authored here\n', 'utf8')
  await mkdir(join(root, 'resources', 'studio-plugin', 'workflow-roles', 'skills', 'old-role'), { recursive: true })
  await writeFile(
    join(root, 'resources', 'studio-plugin', 'workflow-roles', 'skills', 'old-role', 'SKILL.md'),
    'stale seed\n',
    'utf8',
  )

  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, '--from', from, '--root', root], {
    cwd: REPO_ROOT,
  })
  assert.match(stdout, /workflow-roles: 1 skills \(architect\), version 1\.0\.1/)

  const published = await readFile(
    join(root, 'resources', 'studio-plugin', 'workflow-roles', 'skills', 'architect', 'SKILL.md'),
    'utf8',
  )
  assert.equal(published, '---\nname: architect\n---\npublished\n')
  await assert.rejects(
    readFile(join(root, 'resources', 'studio-plugin', 'workflow-roles', 'skills', 'old-role', 'SKILL.md'), 'utf8'),
    { code: 'ENOENT' },
    'the seed is replaced as one directory, not merged with a stale skill',
  )

  const keep = await readFile(join(root, 'resources', 'studio-plugin', 'sprintengine-studio', 'KEEP.txt'), 'utf8')
  assert.equal(keep, 'authored here\n')
  await assert.rejects(
    readFile(join(root, 'resources', 'studio-plugin', 'sprintengine-studio', 'POISON.txt'), 'utf8'),
    { code: 'ENOENT' },
    'sprintengine-studio is never pulled back over',
  )
  await assert.rejects(
    readFile(join(root, 'resources', 'studio-plugin', 'studio-skills', 'skills', 'frontend-design', 'SKILL.md'), 'utf8'),
    { code: 'ENOENT' },
    'studio-skills is not re-added from the published tree',
  )

  const marketplace = JSON.parse(
    await readFile(join(root, 'resources', 'studio-plugin', '.claude-plugin', 'marketplace.json'), 'utf8'),
  ) as { plugins: { name: string; version: string }[] }
  assert.deepEqual(
    marketplace.plugins.map((entry) => `${entry.name}@${entry.version}`),
    ['sprintengine-studio@1.0.0', 'studio-skills@1.0.0', 'workflow-roles@1.0.1'],
    'workflow-roles version refreshes; studio-skills is left listed, never re-added',
  )

  console.log('sync-catalogue: ok')
}

void main()
