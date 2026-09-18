// Sync: the scan that added a source, pointed at a source that already exists.
//
// Two things happen and neither is a merge. The cached scan is replaced by a
// fresh one taken at the repository's current head, and every skill from that
// source the workspace already holds is copied again from it. Installing is a
// file copy, so updating is the same file copy — there are no hunks to choose,
// which is why nothing here computes a diff and nothing above it renders one.
//
// The re-copy is deliberately blind *within* a source: a skill edited in place
// is overwritten. That trade is recorded in
// backlog/2026-07-28-skill-source-sync.md, with the cheap fix (compare each
// file's blob SHA before writing) named there for the day it bites. It does not
// extend across sources — what a sync may overwrite is what that same source
// installed, proven by the provenance marker install writes.
//
// The MCP servers a source installed follow the same shape, at the bottom of
// this file: the marker there is `McpServerConfig.sourceRef`, and because MCP
// settings live in the renderer's store the rule is pure and the surface
// applies its result.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { McpServerConfig, SkillHarness } from '../../shared/electron-api'
import { referencesPluginRoot, resolvePluginRoot } from '../../shared/mcp/plugin-root'
import { isOwnedBySource, mcpServerConfigFromScanned } from '../../shared/mcp/server-from-scanned'
import { SKILL_HARNESS_DIR, SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses'
import {
  scanMcpServers,
  skillDirName,
  type ScanResult,
  type ScannedSkill,
  type SkillFileRef,
} from '../../shared/skills'
import { installSkill, readSkillProvenance } from './install'

export type SkillSyncChanges = { added: string[]; removed: string[] }

/**
 * What the refreshed scan holds that the cached one did not, and what it has
 * stopped holding. Skill ids only: this is the whole of what a sync can say
 * about a source without inventing prose about someone else's commits.
 */
export function diffScannedSkills(previous: ScanResult | null, next: ScanResult): SkillSyncChanges {
  const before = new Set((previous?.skills ?? []).map((skill) => skill.id))
  const after = new Set(next.skills.map((skill) => skill.id))
  return {
    added: next.skills.filter((skill) => !before.has(skill.id)).map((skill) => skill.id),
    removed: (previous?.skills ?? []).filter((skill) => !after.has(skill.id)).map((skill) => skill.id),
  }
}

/** One installed skill directory, and the source whose install wrote it. */
export type InstalledSkillCopy = { harness: SkillHarness; sourceId: string }

/**
 * The installed copies this app can account for, keyed by the directory name an
 * install writes.
 *
 * Read across every harness directory rather than the CLIs detected on this
 * machine: a skill copied into `.claude/skills` is installed whether or not
 * that CLI answers `which` today, and a sync that quietly stopped refreshing it
 * would leave the workspace on bytes nobody chose. Copying back into exactly
 * the directories that hold it also means a sync never creates a copy the user
 * never installed.
 *
 * A directory carrying no provenance marker — a bundled skill, one made by
 * hand, a copy installed before markers existed — is left out entirely. Nothing
 * says which source it came from, so nothing may overwrite it; installing it
 * from a source is what claims it, and that writes the marker.
 */
export async function installedSkillCopies(workspaceRoot: string): Promise<Map<string, InstalledSkillCopy[]>> {
  const byDirName = new Map<string, InstalledSkillCopy[]>()
  for (const harness of SKILL_PACK_HARNESSES) {
    const skillsDir = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills')
    const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const provenance = await readSkillProvenance(join(skillsDir, entry.name))
      if (!provenance) continue
      const copy: InstalledSkillCopy = { harness, sourceId: provenance.sourceId }
      const copies = byDirName.get(entry.name)
      if (copies) copies.push(copy)
      else byDirName.set(entry.name, [copy])
    }
  }
  return byDirName
}

type SkillSyncCopyFailure = { skillId: string; message: string }
export type SkillSyncCopyResult = { refreshed: string[]; failures: SkillSyncCopyFailure[] }

/**
 * Re-copy the skills this workspace already holds *from this source*, out of
 * the refreshed scan.
 *
 * Only skills the new scan still lists are copied. One that disappeared
 * upstream keeps the copy it already has — dropping out of the source's list is
 * not a reason to take a working skill away from the agents reading it.
 *
 * A matching directory name is not enough to be copied over: the copy on disk
 * must name this source. Two repositories shipping a `prototype` skill is
 * ordinary, and the one the user installed is the one that gets updated. A copy
 * belonging to another source, or to nothing, is left alone and left out of
 * `refreshed` — sync only reports what it actually wrote.
 */
export async function refreshInstalledSkills(options: {
  workspaceRoot: string
  sourceId: string
  scan: ScanResult
  installedCopies: ReadonlyMap<string, InstalledSkillCopy[]>
  readFile: (skill: ScannedSkill, file: SkillFileRef) => Promise<Buffer>
}): Promise<SkillSyncCopyResult> {
  const refreshed: string[] = []
  const failures: SkillSyncCopyFailure[] = []
  for (const skill of options.scan.skills) {
    const copies = options.installedCopies.get(skillDirName(skill.id)) ?? []
    const harnesses = copies.filter((copy) => copy.sourceId === options.sourceId).map((copy) => copy.harness)
    if (harnesses.length === 0) continue
    // Sequential on purpose: each copy fetches every file of its skill, and a
    // fan-out of those reads is what a rate limit is for.
    const result = await installSkill({
      workspaceRoot: options.workspaceRoot,
      skill,
      harnesses,
      readFile: (file) => options.readFile(skill, file),
      provenance: { sourceId: options.sourceId, skillId: skill.id, commitSha: options.scan.commitSha },
    }).catch((error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    }))
    if (result.ok) refreshed.push(skill.id)
    else failures.push({ skillId: skill.id, message: result.message })
  }
  return { refreshed, failures }
}

// ── MCP servers ─────────────────────────────────────────────────────────────

/**
 * What a sync means for the MCP servers a source installed
 * (backlog/2026-09-05-plugin-sources.md, "Sync and updates").
 *
 * `updated` is every entry the caller should write back — MCP settings live in
 * the renderer's store, so this rule is pure and the surface applies it, the
 * same split the install already uses.
 */
export type McpSourceRefresh = {
  updated: McpServerConfig[]
  /** Ids whose declaration really moved — what the sync line may claim. */
  changed: string[]
  /** Ids the source no longer declares; their entries stay, marked. */
  missing: string[]
}

/**
 * Re-write the servers this source installed from its refreshed scan.
 *
 * Three rules, and each is the MCP twin of one the skill re-copy already
 * follows:
 *
 *  - Only entries whose `sourceRef` names THIS source are touched. A
 *    hand-typed server and one from another source are left exactly as they
 *    are, even when the ids collide — the provenance marker is the proof, not
 *    the name.
 *  - A server the source has stopped declaring keeps its entry and is marked
 *    `missing`, so it goes on working and the row can say it is no longer in
 *    its source. Deleting a server someone's agents are using because a
 *    repository moved on is not an update, it is data loss.
 *  - What the person chose is kept over what the source declares: `enabled`,
 *    the CLIs it targets, its scope, and the values they filled in for the
 *    variables the source only NAMES. Everything the source itself gives a
 *    value to is the source's to correct — see `refreshedEnv`.
 */
export function refreshSourceMcpServers(input: {
  sourceId: string
  servers: readonly McpServerConfig[]
  scan: ScanResult
  /** The commit the refreshed scan was taken at; stamped on every entry it rewrites. */
  commitSha: string
}): McpSourceRefresh {
  // A scan that carries no `mcpServers` field never looked for servers — a
  // folder scan today, or a listing cached before this field existed. That is
  // not the same as a source that declares none, and reading it as one would
  // stamp "no longer in source" on every server the source installed. Nothing
  // was read, so nothing is said.
  if (input.scan.mcpServers === undefined) return { updated: [], changed: [], missing: [] }
  const declared = new Map(scanMcpServers(input.scan).map((server) => [server.id, server]))
  const updated: McpServerConfig[] = []
  const changed: string[] = []
  const missing: string[] = []
  for (const server of input.servers) {
    if (!isOwnedBySource(server, input.sourceId)) continue
    const itemId = server.sourceRef?.itemId ?? ''
    const scanned = declared.get(itemId)
    if (!scanned) {
      if (server.sourceRef?.missing === true) continue
      missing.push(server.id)
      updated.push({ ...server, sourceRef: { ...server.sourceRef!, missing: true } })
      continue
    }
    // A server whose command runs out of the plugin's own directory is
    // re-resolved against the directory the install recorded on the entry.
    // Without this, a sync would write `${CLAUDE_PLUGIN_ROOT}` back over a
    // working absolute path and break the server it was refreshing
    // (backlog/2026-09-06-a-plugins-own-files-must-land-before-its-server-can-start.md).
    // The root is the entry's, not looked up: MCP settings are app-level and a
    // sync runs with no workspace open.
    const pluginRoot = server.sourceRef?.pluginRoot ?? ''
    const fresh = mcpServerConfigFromScanned(
      pluginRoot !== '' && referencesPluginRoot(scanned) ? resolvePluginRoot(scanned, pluginRoot) : scanned,
      server.clients,
      {
        sourceId: input.sourceId,
        itemId,
        commitSha: input.commitSha,
        ...(pluginRoot !== '' ? { pluginRoot } : {}),
      },
    )
    const next: McpServerConfig = {
      ...fresh,
      // The id is the entry's identity in the settings map; a source that
      // renames its server would otherwise orphan the old entry rather than
      // update it.
      id: server.id,
      enabled: server.enabled,
      required: server.required,
      scope: server.scope,
      env: refreshedEnv(fresh, server),
    }
    if (declarationChanged(server, next)) changed.push(server.id)
    updated.push(next)
  }
  return { updated, changed, missing }
}

/**
 * The environment a refreshed entry runs with.
 *
 * The source's map is the base, so a corrected default lands and a variable the
 * source has stopped shipping goes with it — merging the stored map over the
 * fresh one made every default permanently un-updatable and kept dead keys
 * (a withdrawn secret would have stayed in `.mcp.json` for good).
 *
 * The exception is a variable the source NAMES without valuing
 * (`envVarNames`): the only place a value for one of those can have come from
 * is the person, so theirs is kept. A name the source has dropped keeps
 * nothing, because the server no longer reads it.
 */
function refreshedEnv(fresh: McpServerConfig, installed: McpServerConfig): Record<string, string> {
  const next: Record<string, string> = { ...fresh.env }
  for (const name of fresh.envVarNames ?? []) {
    if (name in next) continue
    const filledIn = installed.env?.[name]
    if (filledIn !== undefined) next[name] = filledIn
  }
  return next
}

/** Everything a source declares, ignoring the parts the person owns. */
function declarationChanged(before: McpServerConfig, after: McpServerConfig): boolean {
  const shape = (server: McpServerConfig): string =>
    JSON.stringify([
      server.name,
      server.description ?? '',
      server.transport,
      server.command ?? '',
      server.args ?? [],
      server.url ?? '',
      server.env ?? {},
      server.envVarNames ?? [],
      server.headers ?? {},
      server.riskLevel,
    ])
  return shape(before) !== shape(after)
}
