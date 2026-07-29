import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { adoptLegacySkillPackSources, LEGACY_SKILL_PACKS } from './adopt-legacy-packs'
import { createSkillSourceStore } from './source-store'

async function storeInTemp() {
  const dir = await mkdtemp(join(tmpdir(), 'multicode-adopt-packs-'))
  return { dir, store: createSkillSourceStore(dir) }
}

async function workspaceHolding(dirNames: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-adopt-ws-'))
  for (const dirName of dirNames) {
    await mkdir(join(root, '.agents', 'skills', dirName), { recursive: true })
  }
  return root
}

async function main(): Promise<void> {
  // Only what is actually installed is adopted: a workspace holding one pack
  // does not inherit the other three as sources.
  {
    const { store } = await storeInTemp()
    const workspaceRoot = await workspaceHolding(['impeccable'])
    const adopted = await adoptLegacySkillPackSources({ store, workspaceRoots: [workspaceRoot] })

    assert.deepEqual(adopted.map((source) => source.repo), ['pbakaus/impeccable'])
    const listed = await store.listSources()
    assert.deepEqual(
      listed.filter((source) => source.kind === 'github').map((source) => source.id),
      ['github:pbakaus/impeccable'],
    )
    // No scan is invented for it: what the repository holds today is a network
    // read, and Sync is what performs it.
    assert.equal(await store.getScan('github:pbakaus/impeccable'), null)
    assert.equal(listed.find((source) => source.repo === 'pbakaus/impeccable')?.scannedAt, '')
  }

  // A workspace holding none of them adopts nothing at all.
  {
    const { store } = await storeInTemp()
    const workspaceRoot = await workspaceHolding(['some-other-skill'])
    const adopted = await adoptLegacySkillPackSources({ store, workspaceRoots: [workspaceRoot] })

    assert.deepEqual(adopted, [])
    assert.deepEqual((await store.listSources()).filter((source) => source.kind === 'github'), [])
  }

  // It runs once. A source the user removed after adoption stays removed.
  {
    const { store } = await storeInTemp()
    const workspaceRoot = await workspaceHolding(['taste'])
    await adoptLegacySkillPackSources({ store, workspaceRoots: [workspaceRoot] })
    assert.equal(await store.removeSource('github:leonxlnx/taste-skill'), true)

    const second = await adoptLegacySkillPackSources({ store, workspaceRoots: [workspaceRoot] })
    assert.deepEqual(second, [])
    assert.deepEqual((await store.listSources()).filter((source) => source.kind === 'github'), [])
  }

  // With no workspace open there is nowhere to look, so the migration stays
  // pending rather than marking itself done against an empty search.
  {
    const { store } = await storeInTemp()
    assert.deepEqual(await adoptLegacySkillPackSources({ store, workspaceRoots: [] }), [])
    assert.equal(await store.hasAdoptedLegacyPacks(), false)

    const workspaceRoot = await workspaceHolding(['ui-ux-pro-max'])
    const later = await adoptLegacySkillPackSources({ store, workspaceRoots: [workspaceRoot] })
    assert.deepEqual(later.map((source) => source.repo), ['nextlevelbuilder/ui-ux-pro-max-skill'])
  }

  // Every workspace is searched, and a pack present in any of them is adopted.
  {
    const { store } = await storeInTemp()
    const empty = await workspaceHolding([])
    const withPack = await workspaceHolding(['frontend-design'])
    const adopted = await adoptLegacySkillPackSources({
      store,
      workspaceRoots: [empty, withPack],
    })
    assert.deepEqual(adopted.map((source) => source.repo), ['anthropics/skills'])
  }

  // The retired catalogue, as it shipped: four packs, each naming the
  // repository it came from and the directory it installed as.
  assert.equal(LEGACY_SKILL_PACKS.length, 4)
  assert.ok(LEGACY_SKILL_PACKS.every((pack) => pack.repo.includes('/') && pack.installedDirName.length > 0))

  console.log('adopt-legacy-packs tests passed')
}

void main()
