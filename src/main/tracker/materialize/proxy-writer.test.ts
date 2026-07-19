import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  markProxyBacklogItemUnavailable,
  materializeProxyBacklogItem,
  updateBacklogDependencies,
  updateBacklogEpic,
  updateBacklogStatus,
} from '../../backlog-service'
import { parseBacklogFrontmatter } from '../../../shared/backlog/frontmatter'

// Writer unit matrix (plan §3.4): create, re-materialize/refresh (upsert),
// external-identity round-trip, ownership split (local triage untouched), slug
// collision, and deleted-upstream unavailable marking — all against a temp
// workspace, no tracker HTTP.

const GH_EXTERNAL_ID = 'acme/web#17'

async function backlogFiles(root: string): Promise<string[]> {
  const entries = await readdir(join(root, 'backlog'), { withFileTypes: true })
  return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort()
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-proxy-writer-'))
  await mkdir(join(root, 'backlog'), { recursive: true })
  try {
    // --- create -----------------------------------------------------------
    const created = await materializeProxyBacklogItem({
      workspaceRoot: root,
      provider: 'github',
      connectionId: 'trk-1',
      externalId: GH_EXTERNAL_ID,
      externalKey: '#17',
      externalUrl: 'https://github.com/acme/web/issues/17',
      title: 'Fix login redirect',
      body: '# Fix login redirect\n\n**State:** Open\n\nThe redirect loops.\n',
    })
    assert.equal(created.ok, true)
    assert.equal(created.ok && created.outcome, 'added')
    let files = await backlogFiles(root)
    assert.equal(files.length, 1, 'create writes exactly one file')
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}-github-17-fix-login-redirect\.md$/)

    const relativePath = `backlog/${files[0]}`
    let raw = await readFile(join(root, relativePath), 'utf-8')
    let parsed = parseBacklogFrontmatter(raw)
    // Flat underscore external identity, round-tripped (incl. the `/` and `#` id).
    assert.equal(parsed.fields.external_provider, 'github')
    assert.equal(parsed.fields.external_connection, 'trk-1')
    assert.equal(parsed.fields.external_id, GH_EXTERNAL_ID)
    assert.equal(parsed.fields.external_key, '#17')
    assert.equal(parsed.fields.external_url, 'https://github.com/acme/web/issues/17')
    assert.equal(parsed.fields.status, 'idea', 'proxy seeds an editable idea status')
    assert.equal(parsed.fields.id, undefined, 'writer never allocates an id ad-hoc (scan self-heals it)')
    assert.match(parsed.body, /The redirect loops\./)

    // --- ownership split: local triage edits survive a refresh ------------
    assert.equal((await updateBacklogStatus({ workspaceRoot: root, relativePath, status: 'in_progress' })).ok, true)
    assert.equal((await updateBacklogEpic({ workspaceRoot: root, relativePath, epic: 'auth-revamp' })).ok, true)
    assert.equal((await updateBacklogDependencies({ workspaceRoot: root, relativePath, dependsOn: ['other-item'] })).ok, true)
    // Simulate the scan-time id allocation having stamped an id.
    await writeFile(
      join(root, relativePath),
      (await readFile(join(root, relativePath), 'utf-8')).replace('status: in_progress', 'id: 5\nstatus: in_progress'),
      'utf-8'
    )

    // --- re-materialize / refresh: same file, refreshed body -------------
    const refreshed = await materializeProxyBacklogItem({
      workspaceRoot: root,
      provider: 'github',
      connectionId: 'trk-1',
      externalId: GH_EXTERNAL_ID,
      externalKey: '#17',
      externalUrl: 'https://github.com/acme/web/issues/17',
      title: 'Fix login redirect (renamed upstream)',
      body: '# Fix login redirect\n\n**State:** Closed\n\nResolved by the redirect guard.\n',
    })
    assert.equal(refreshed.ok, true)
    assert.equal(refreshed.ok && refreshed.outcome, 'refreshed')
    assert.equal(refreshed.ok && refreshed.relativePath, relativePath, 'refresh reuses the same file, never renames')
    files = await backlogFiles(root)
    assert.equal(files.length, 1, 'a second pull of the same issue never duplicates the file')

    raw = await readFile(join(root, relativePath), 'utf-8')
    parsed = parseBacklogFrontmatter(raw)
    assert.equal(parsed.fields.status, 'in_progress', 'local status untouched by refresh')
    assert.equal(parsed.fields.epic, 'auth-revamp', 'local epic untouched by refresh')
    assert.equal(parsed.fields.dependson, 'other-item', 'local dependsOn untouched by refresh')
    assert.equal(parsed.fields.id, '5', 'the allocated numeric id survives refresh')
    assert.match(parsed.body, /Resolved by the redirect guard\./, 'body reflects the upstream refresh')
    assert.doesNotMatch(parsed.body, /The redirect loops\./, 'stale body content is replaced')

    // --- slug collision: a different issue with the same computed base ---
    const collided = await materializeProxyBacklogItem({
      workspaceRoot: root,
      provider: 'github',
      connectionId: 'trk-1',
      externalId: 'acme/web#18',
      externalKey: '#17', // same key slug + same title ⇒ same base as the first
      externalUrl: 'https://github.com/acme/web/issues/18',
      title: 'Fix login redirect',
      body: '# Fix login redirect\n\nA different issue.\n',
    })
    assert.equal(collided.ok, true)
    assert.equal(collided.ok && collided.outcome, 'added')
    assert.match(collided.ok ? collided.relativePath : '', /-2\.md$/, 'a colliding base gets a -2 suffix, not a clobber')
    files = await backlogFiles(root)
    assert.equal(files.length, 2)

    // --- deleted upstream: mark unavailable, never delete ---------------
    const marked = await markProxyBacklogItemUnavailable({
      workspaceRoot: root,
      connectionId: 'trk-1',
      externalId: GH_EXTERNAL_ID,
      providerLabel: 'GitHub',
      reason: 'No longer available in GitHub.',
    })
    assert.equal(marked.ok, true)
    assert.equal(marked.ok && marked.found, true)
    files = await backlogFiles(root)
    assert.equal(files.length, 2, 'an unavailable issue is marked, never deleted')
    raw = await readFile(join(root, relativePath), 'utf-8')
    parsed = parseBacklogFrontmatter(raw)
    assert.equal(parsed.fields.external_unavailable, 'No longer available in GitHub.')
    assert.match(parsed.body, /no longer available in GitHub/i, 'a visible banner replaces silent staleness')
    assert.match(parsed.body, /Resolved by the redirect guard\./, 'the last synced copy is preserved below the banner')
    assert.equal(parsed.fields.status, 'in_progress', 'marking unavailable never touches local triage')

    // Re-marking is idempotent (one banner, one flag).
    const remarked = await markProxyBacklogItemUnavailable({
      workspaceRoot: root,
      connectionId: 'trk-1',
      externalId: GH_EXTERNAL_ID,
      providerLabel: 'GitHub',
      reason: 'No longer available in GitHub.',
    })
    assert.equal(remarked.ok, true)
    const rawAfter = await readFile(join(root, relativePath), 'utf-8')
    assert.equal((rawAfter.match(/tracker-unavailable/g) ?? []).length, 1, 're-marking does not stack banners')

    // A successful refresh clears the unavailable flag and banner.
    const recovered = await materializeProxyBacklogItem({
      workspaceRoot: root,
      provider: 'github',
      connectionId: 'trk-1',
      externalId: GH_EXTERNAL_ID,
      externalKey: '#17',
      externalUrl: 'https://github.com/acme/web/issues/17',
      title: 'Fix login redirect',
      body: '# Fix login redirect\n\nBack again.\n',
    })
    assert.equal(recovered.ok, true)
    parsed = parseBacklogFrontmatter(await readFile(join(root, relativePath), 'utf-8'))
    assert.equal(parsed.fields.external_unavailable, undefined, 'a live refresh clears the unavailable flag')
    assert.doesNotMatch(parsed.body, /tracker-unavailable/, 'the banner is gone after a live refresh')

    // --- unknown proxy: not found is not an unavailable item ------------
    const unknown = await markProxyBacklogItemUnavailable({
      workspaceRoot: root,
      connectionId: 'trk-1',
      externalId: 'acme/web#999',
      providerLabel: 'GitHub',
      reason: 'gone',
    })
    assert.equal(unknown.ok, true)
    assert.equal(unknown.ok && unknown.found, false, 'no matching proxy ⇒ found:false, not a phantom item')

    console.log('proxy-writer tests passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
