#!/usr/bin/env node
// One-time migration for backlog items that mirror a tracker issue (MC-2359).
//
// Materialization is gone: a tracker issue is no longer copied into `backlog/`
// as a Markdown file. Anyone who used the old "Add from tracker" flow has real
// files committed in their repo, and orphaning them silently would be worse than
// the mirror was. This reports what it would do, and only acts with `--apply`.
//
//   node scripts/migrate-tracker-proxy-items.mjs            # report only
//   node scripts/migrate-tracker-proxy-items.mjs --apply    # act
//   node scripts/migrate-tracker-proxy-items.mjs --root /path/to/project
//
// Three outcomes, decided per file:
//
//   delete  — the item is a pure copy: nothing but the tracker's own content.
//             Nothing is lost; the issue is still in the tracker.
//   keep    — the user added Multicode-owned state (an epic, a dependency, a
//             triage axis, a highlight). The `external_*` keys and the synced
//             body are stripped and it becomes an ordinary backlog item that
//             links to the issue.
//   keep    — a sprint ran against it. That history is real, so a file carrying
//             an execution link is never deleted, whatever else it holds.
//
// Idempotent: a second run finds nothing, because the marker it keys on
// (`external_id` + `external_connection`) is what it removes.

import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const rootFlag = args.indexOf('--root')
const root = resolve(rootFlag === -1 ? process.cwd() : args[rootFlag + 1])

// Multicode-owned frontmatter. Any of these present means the user put something
// here that the tracker does not know about, so the file is kept and stripped
// rather than deleted. `status` counts only when it is not materialization's own
// default of `idea`.
const OWNED_KEYS = ['epic', 'dependson', 'difficulty', 'criticality', 'risk', 'highlight', 'mockups']

function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n')) return { fields: {}, body: raw, block: '' }
  const end = raw.indexOf('\n---', 4)
  if (end === -1) return { fields: {}, body: raw, block: '' }
  const block = raw.slice(0, end + 4)
  const fields = {}
  for (const line of raw.slice(4, end).split('\n')) {
    const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (match) fields[match[1].toLowerCase()] = match[2].trim()
  }
  return { fields, body: raw.slice(block.length).replace(/^\n/, ''), block }
}

async function readSidecarLinks() {
  try {
    const raw = await readFile(join(root, '.multi-code/backlog/items.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    const byPath = new Map()
    for (const item of parsed.items ?? []) {
      const path = item?.source?.relativePath
      if (typeof path === 'string') byPath.set(path, item.links ?? [])
    }
    return byPath
  } catch {
    return new Map()
  }
}

async function main() {
  const backlogDir = join(root, 'backlog')
  let names
  try {
    names = await readdir(backlogDir)
  } catch {
    console.error(`No backlog/ directory under ${root}.`)
    process.exit(1)
  }

  const links = await readSidecarLinks()
  const planned = []

  for (const name of names.filter((entry) => entry.endsWith('.md')).sort()) {
    const relativePath = `backlog/${name}`
    const raw = await readFile(join(backlogDir, name), 'utf-8')
    const { fields, body, block } = parseFrontmatter(raw)
    if (!fields.external_id || !fields.external_connection) continue

    const itemLinks = links.get(relativePath) ?? []
    const hasRun = itemLinks.some((link) => link?.type === 'execution')
    const owned = OWNED_KEYS.filter((key) => (fields[key] ?? '').length > 0)
    if ((fields.status ?? 'idea') !== 'idea') owned.push('status')

    if (hasRun) {
      planned.push({ relativePath, action: 'keep', why: 'a sprint ran against it' })
    } else if (owned.length > 0) {
      planned.push({ relativePath, action: 'keep', why: `you set ${owned.join(', ')}` })
    } else {
      planned.push({ relativePath, action: 'delete', why: 'a pure copy — still in the tracker' })
    }
  }

  if (planned.length === 0) {
    console.log('No mirrored tracker items found. Nothing to migrate.')
    return
  }

  for (const entry of planned) {
    console.log(`${entry.action === 'delete' ? 'delete' : 'keep  '}  ${entry.relativePath}  — ${entry.why}`)
  }
  const deletions = planned.filter((entry) => entry.action === 'delete').length
  console.log(`\n${planned.length} mirrored item(s): ${deletions} to delete, ${planned.length - deletions} to keep and strip.`)

  if (!apply) {
    console.log('\nReport only. Re-run with --apply to act.')
    return
  }

  for (const entry of planned) {
    const path = join(root, entry.relativePath)
    if (entry.action === 'delete') {
      await unlink(path)
      continue
    }
    const raw = await readFile(path, 'utf-8')
    const { fields, block } = parseFrontmatter(raw)
    // Strip the external_* identity and replace the synced body with a stub that
    // says where the work actually lives. The user's own frontmatter survives.
    const keptFrontmatter = block
      .split('\n')
      .filter((line) => !/^external_[a-z]+:/.test(line))
      .join('\n')
    const title = fields.external_key ? `${fields.external_key}` : 'Tracker issue'
    const url = fields.external_url ?? ''
    const stub = [
      `# ${title}`,
      '',
      url ? `This item tracked [${title}](${url}).` : `This item tracked ${title}.`,
      '',
      'The issue itself is the system of record. Multicode no longer keeps a copy here —',
      'start a sprint straight from the tracker instead.',
      '',
    ].join('\n')
    await writeFile(path, `${keptFrontmatter}\n${stub}`, 'utf-8')
  }
  console.log('\nDone.')
}

void main()
