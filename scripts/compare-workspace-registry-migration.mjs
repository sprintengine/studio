#!/usr/bin/env node
/**
 * Compare a real profile's pre-migration workspace registry against the
 * registry main wrote after the MC-2158 inversion.
 *
 * This is the only check that exercises a real user's data rather than a
 * fixture, so it is what the item's "existing users' workspaces survive the
 * hydration migration byte-for-byte in name/folder/mode/roster" acceptance
 * criterion is verified with. Everything else is covered by
 * `test:main:workspace-registry-migration`-style fixtures.
 *
 * Usage:
 *
 *   1. Copy a real profile's userData directory to a scratch dir. The copy
 *      includes the Chromium `Local Storage` LevelDB holding the legacy
 *      `multicode-workspaces` key.
 *
 *        cp -R "$HOME/Library/Application Support/Multicode" /tmp/mc-profile
 *
 *   2. Capture the PRE-migration renderer state. Launch the OLD build against
 *      the copy, open devtools on any window, and save the raw key:
 *
 *        copy(localStorage.getItem('multicode-workspaces'))
 *        # paste into /tmp/mc-profile/pre-migration-workspaces.json
 *
 *   3. Launch the NEW build against the same copy so main hydrates:
 *
 *        npm run build && npx electron out/main/index.js --user-data-dir=/tmp/mc-profile
 *
 *   4. Compare:
 *
 *        node scripts/compare-workspace-registry-migration.mjs \
 *          --before /tmp/mc-profile/pre-migration-workspaces.json \
 *          --after  /tmp/mc-profile/workspace-registry.json
 *
 * Exit code 0 means every workspace matched on the fields the criterion names.
 * Any mismatch is printed per workspace id and exits 1 — a workspace present
 * before and absent after is the loudest of them, because that is the failure
 * the whole hydration guard exists to prevent.
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
function arg(name) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

const beforePath = arg('before')
const afterPath = arg('after')
if (!beforePath || !afterPath) {
  console.error('usage: compare-workspace-registry-migration.mjs --before <legacy-key.json> --after <workspace-registry.json>')
  process.exit(2)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`could not read ${path}: ${error instanceof Error ? error.message : error}`)
    process.exit(2)
  }
}

// The legacy key is a zustand envelope; accept the raw string form too, since
// devtools `copy()` of the key yields exactly that.
const beforeRaw = readJson(beforePath)
const beforeState = typeof beforeRaw === 'string'
  ? JSON.parse(beforeRaw)?.state
  : beforeRaw?.state ?? beforeRaw
const beforeWorkspaces = Array.isArray(beforeState?.workspaces) ? beforeState.workspaces : []

const afterFile = readJson(afterPath)
const afterWorkspaces = Array.isArray(afterFile?.workspaces) ? afterFile.workspaces : []

if (beforeWorkspaces.length === 0) {
  console.error('the pre-migration state has no workspaces — nothing to compare, and nothing this check can attest')
  process.exit(2)
}

// The roster fields the criterion names. `cliSessionId` and `cliResumeAvailable`
// are load-bearing (they are what `claude --resume` and `codex resume` read), so
// losing them silently would look like a clean migration and behave like a
// broken one.
const AGENT_FIELDS = ['kind', 'cli', 'specialistId', 'cliSessionId', 'cliResumeAvailable']

function agentSummary(agents) {
  return Object.fromEntries(
    Object.entries(agents ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, agent]) => [id, Object.fromEntries(AGENT_FIELDS.map((field) => [field, agent?.[field] ?? null]))]),
  )
}

function summary(workspace) {
  return {
    name: workspace.name ?? null,
    folderPath: workspace.folderPath ?? null,
    mode: workspace.mode ?? null,
    agents: agentSummary(workspace.agents),
  }
}

const afterById = new Map(afterWorkspaces.map((workspace) => [workspace.id, workspace]))
const problems = []

for (const before of beforeWorkspaces) {
  const after = afterById.get(before.id)
  if (!after) {
    problems.push({ id: before.id, name: before.name, issue: 'MISSING after migration' })
    continue
  }
  const left = JSON.stringify(summary(before))
  const right = JSON.stringify(summary(after))
  if (left !== right) {
    problems.push({ id: before.id, name: before.name, issue: 'CHANGED', before: summary(before), after: summary(after) })
  }
}

const added = afterWorkspaces.filter((workspace) => !beforeWorkspaces.some((entry) => entry.id === workspace.id))

console.log(`compared ${beforeWorkspaces.length} pre-migration workspaces against ${afterWorkspaces.length} in the registry`)
if (added.length > 0) {
  // Not a failure: the new build may have minted a workspace during the run.
  console.log(`note: ${added.length} workspace(s) present only after migration: ${added.map((w) => w.id).join(', ')}`)
}

if (problems.length === 0) {
  console.log('OK — every workspace matched on name, folderPath, mode, and roster')
  process.exit(0)
}

for (const problem of problems) {
  console.error(`\n${problem.issue}: ${problem.id} (${problem.name ?? 'unnamed'})`)
  if (problem.before) {
    console.error('  before:', JSON.stringify(problem.before, null, 2))
    console.error('  after: ', JSON.stringify(problem.after, null, 2))
  }
}
console.error(`\n${problems.length} workspace(s) did not survive the migration intact`)
process.exit(1)
