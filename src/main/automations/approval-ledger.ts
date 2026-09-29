import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type {
  AutomationApproval,
  AutomationApprovalSource,
  AutomationDefinition,
} from '../../shared/automations/contracts'
import { isRecord } from '../../shared/records'

// The approval ledger: what this machine has said yes to. It lives in the app's
// userData and never in the project, because the project is exactly what cannot
// be trusted to vouch for itself — a definition file arrives with a clone, a
// `git pull`, or an agent's write, and an automation it describes runs an agent
// unattended, on `bypass` unless it says otherwise. Keyed by the project's real
// path and the automation id; the value is a fingerprint of what the automation
// does, so a file that changes after the yes is waiting again.
//
// A missing or unreadable ledger means nothing is approved — the safe reading,
// and the one a fresh install and a hand-deleted file both land on.

const LEDGER_FILE_NAME = 'automation-approvals.json'
const LEDGER_VERSION = 1

// Versioned so a change to what is hashed retires every old fingerprint at once
// (everything asks again) rather than matching some of them by accident.
const FINGERPRINT_DOMAIN = 'sprintengine-automation-approval/v1'

// What a fingerprint leaves out, and why each is safe to leave out. Everything
// else in the file is in it, including keys this build does not know: a field a
// later build (or an attacker) adds changes the fingerprint rather than riding
// along unreviewed.
// - `id` is the ledger key already.
// - `name` is a label. It reaches the agent only as its tab name.
// - `status` is whether it runs, not what it does. The engine pauses a once-off
//   itself after its shot, and that write must not cost the approval.
// - `nextRunAt`, `lastRunAt`, `lastRunId`, `createdAt`, `updatedAt` are the
//   engine's own bookkeeping, rewritten after every run.
// - `legacyWriteUpOnly` is derived at read from a retired key and never written
//   back, so the engine's first rewrite of a legacy file drops it; hashing it
//   would un-approve that file after its first run.
const UNFINGERPRINTED_FIELDS = new Set([
  'id',
  'name',
  'status',
  'nextRunAt',
  'lastRunAt',
  'lastRunId',
  'createdAt',
  'updatedAt',
  'legacyWriteUpOnly',
])

type LedgerEntry = {
  fingerprint: string
  source: AutomationApprovalSource
  approvedAt: string
}

// realpath(project root) → automation id → entry.
type LedgerContents = Map<string, Map<string, LedgerEntry>>

const APPROVAL_SOURCES = new Set<AutomationApprovalSource>(['user', 'app', 'agent', 'module'])

/** The ledger's path under a userData directory. */
export function automationApprovalLedgerPath(userDataDir: string): string {
  return join(userDataDir, LEDGER_FILE_NAME)
}

/**
 * The fingerprint of what a definition does: a sha256 over a canonical
 * serialisation (keys sorted at every depth, `undefined` dropped the way
 * JSON drops it) of every field outside {@link UNFINGERPRINTED_FIELDS}. So the
 * trigger, the condition, and the whole action config — prompt, cli, model,
 * permission preset, target folder, command — plus `runInWorktree`,
 * `disableAfterRun` and the provenance fields.
 */
export function automationApprovalFingerprint(definition: AutomationDefinition): string {
  const behaviour: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(definition)) {
    if (!UNFINGERPRINTED_FIELDS.has(key)) behaviour[key] = value
  }
  const hash = createHash('sha256')
  hash.update(FINGERPRINT_DOMAIN)
  hash.update('\n')
  hash.update(canonicalJson(behaviour))
  return `sha256:${hash.digest('hex')}`
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
  }
  if (isRecord(value)) {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${members.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** The engine's and webhook receiver's view: may this definition, as read, run? */
export type AutomationApprovalGate = {
  check(workspaceRoot: string, definition: AutomationDefinition): Promise<AutomationApproval>
}

export type AutomationApprovalLedger = AutomationApprovalGate & {
  /** Record `definition` as it is now as approved. Returns the approved state. */
  approve(
    workspaceRoot: string,
    definition: AutomationDefinition,
    source: AutomationApprovalSource,
  ): Promise<AutomationApproval>
  /** Forget an approval: the automation asks again. Also how a delete cleans up. */
  revoke(workspaceRoot: string, automationId: string): Promise<void>
}

export function createAutomationApprovalLedger(options: {
  // A thunk resolves on first use, so a module can be built before the app's
  // paths exist. A path that cannot be resolved reads as an empty ledger and
  // refuses writes — nothing approved, the same as a missing file.
  filePath: string | (() => string)
  now?: () => number
}): AutomationApprovalLedger {
  const now = options.now ?? Date.now
  const filePath = (): string => (typeof options.filePath === 'function' ? options.filePath() : options.filePath)
  let loaded: Promise<LedgerContents> | null = null
  // Serialises read-modify-write so two approvals landing together cannot lose
  // one; a failed link does not wedge the chain.
  let writes: Promise<unknown> = Promise.resolve()

  function load(): Promise<LedgerContents> {
    loaded ??= Promise.resolve()
      .then(filePath)
      .then(readLedger, () => new Map() as LedgerContents)
    return loaded
  }

  // The change is made on a copy, and the copy becomes what `check` reads only
  // once it is on disk: a write that fails must not leave this session running
  // something the ledger file does not say was approved.
  function mutate(change: (contents: LedgerContents) => void): Promise<void> {
    const run = writes.then(async () => {
      const next: LedgerContents = new Map(
        [...(await load()).entries()].map(([rootKey, automations]) => [rootKey, new Map(automations)]),
      )
      change(next)
      await writeLedger(filePath(), next)
      loaded = Promise.resolve(next)
    })
    writes = run.catch(() => undefined)
    return run
  }

  return {
    async check(workspaceRoot, definition) {
      const [contents, rootKey] = await Promise.all([load(), ledgerRootKey(workspaceRoot)])
      const fingerprint = automationApprovalFingerprint(definition)
      const entry = contents.get(rootKey)?.get(definition.id)
      if (!entry) return { state: 'needs-approval', fingerprint, reason: 'unreviewed' }
      if (entry.fingerprint !== fingerprint) return { state: 'needs-approval', fingerprint, reason: 'changed' }
      return { state: 'approved', fingerprint, source: entry.source, approvedAt: entry.approvedAt }
    },

    async approve(workspaceRoot, definition, source) {
      const rootKey = await ledgerRootKey(workspaceRoot)
      const entry: LedgerEntry = {
        fingerprint: automationApprovalFingerprint(definition),
        source,
        approvedAt: new Date(now()).toISOString(),
      }
      await mutate((contents) => {
        const automations = contents.get(rootKey) ?? new Map<string, LedgerEntry>()
        automations.set(definition.id, entry)
        contents.set(rootKey, automations)
      })
      return { state: 'approved', ...entry }
    },

    async revoke(workspaceRoot, automationId) {
      const rootKey = await ledgerRootKey(workspaceRoot)
      await mutate((contents) => {
        const automations = contents.get(rootKey)
        if (!automations) return
        automations.delete(automationId)
        if (automations.size === 0) contents.delete(rootKey)
      })
    },
  }
}

// The project's real path, so a symlinked or differently spelled route to the
// same folder finds the same approvals — and a different folder that happens to
// share a spelling later does not. A root that cannot be resolved (gone from
// disk) keys on its absolute spelling; nothing can run from it anyway.
async function ledgerRootKey(workspaceRoot: string): Promise<string> {
  try {
    return await realpath(workspaceRoot)
  } catch {
    return resolve(workspaceRoot)
  }
}

async function readLedger(filePath: string): Promise<LedgerContents> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return new Map()
  }
  try {
    return parseLedger(JSON.parse(raw))
  } catch {
    return new Map()
  }
}

// Entry by entry: one malformed record costs that record, not the ledger.
function parseLedger(value: unknown): LedgerContents {
  const contents: LedgerContents = new Map()
  if (!isRecord(value) || value.version !== LEDGER_VERSION || !isRecord(value.workspaces)) return contents
  for (const [rootKey, automations] of Object.entries(value.workspaces)) {
    if (!isRecord(automations)) continue
    const entries = new Map<string, LedgerEntry>()
    for (const [automationId, entry] of Object.entries(automations)) {
      if (!isRecord(entry)) continue
      const { fingerprint, source, approvedAt } = entry
      if (typeof fingerprint !== 'string' || typeof approvedAt !== 'string') continue
      if (typeof source !== 'string' || !APPROVAL_SOURCES.has(source as AutomationApprovalSource)) continue
      entries.set(automationId, { fingerprint, source: source as AutomationApprovalSource, approvedAt })
    }
    if (entries.size > 0) contents.set(rootKey, entries)
  }
  return contents
}

async function writeLedger(filePath: string, contents: LedgerContents): Promise<void> {
  const workspaces: Record<string, Record<string, LedgerEntry>> = {}
  for (const rootKey of [...contents.keys()].sort()) {
    const automations = contents.get(rootKey)!
    const record: Record<string, LedgerEntry> = {}
    for (const automationId of [...automations.keys()].sort()) record[automationId] = automations.get(automationId)!
    workspaces[rootKey] = record
  }
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify({ version: LEDGER_VERSION, workspaces }, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, filePath)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}
