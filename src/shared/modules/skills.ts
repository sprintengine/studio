// Module-owned skills (WP-D). A capability module can ship agent skills in its
// own tree and hand them to the host; the host then treats them exactly as it
// treats the skills the app bundles — same install fan-out, same managed
// manifest, same `spawnSkillId` resolution at the launch boundary.
//
// Node-free on purpose: these shapes are shared by the module host
// (MainHost.registerSkills), the main-process skill registry
// (src/main/builtin-skills.ts) and the SDK mirror in packages/module-sdk —
// src/shared cannot import src/main (TS6307).

/**
 * Where a skill must land in a workspace.
 *
 * - `'agents'` — the harness-neutral `.agents/skills/<id>` directory only.
 *   Enough for a skill an agent discovers by reading the directory.
 * - `'all-native'` — additionally every installed CLI plugin's own native
 *   skill directory (`.claude/skills`, `.codex/skills`, …). Required when the
 *   skill is invoked by name in a prompt, because a CLI resolves an invocation
 *   only against its own directory.
 */
export type ModuleSkillTargetPolicy = 'agents' | 'all-native'

/**
 * One skill a module ships. `sourceDir` is the directory holding the skill's
 * `SKILL.md` (and any `agents/` sidecars), relative to the module root; the
 * host resolves it and refuses anything that escapes the root. A module with
 * no root on disk (a bundled module) passes an absolute path instead.
 *
 * `id` is the invocation name and must not collide with a built-in skill or
 * with a skill another module already registered.
 */
export type ModuleSkillRegistration = {
  id: string
  sourceDir: string
  targetPolicy: ModuleSkillTargetPolicy
  description: string
}

/**
 * Every status the host's skill installer answers with, so a module can switch
 * on it exhaustively:
 *
 * - `installed` — present and current (written by this app, or nothing to write).
 * - `updated` — `ensureSkillInstalled` replaced an older copy it had written.
 * - `missing` — not in the workspace yet (`getSkillStatus` only; `ensure…` installs it).
 * - `update-available` — present, but older than the copy the module ships
 *   (`getSkillStatus` only; `ensure…` updates it).
 * - `local` — a copy the app did not write is in the way; it is left alone.
 * - `modified` — the app's copy was edited by hand; it is left alone.
 * - `delivered-at-launch` — nothing is written to the workspace: a launch that
 *   asks for this skill is handed it as a plugin of its own (a built-in skill
 *   on a CLI whose launch carries the app's plugin directories).
 * - `missing-source` — the skill's own files are gone from the module or app.
 * - `missing-workspace` — no workspace root was given.
 * - `unknown-skill` — no built-in or registered module skill has that id.
 * - `install-failed` — the write itself failed; `message` says why.
 */
export type ModuleSkillStatus =
  | 'installed'
  | 'updated'
  | 'missing'
  | 'update-available'
  | 'local'
  | 'modified'
  | 'delivered-at-launch'
  | 'missing-source'
  | 'missing-workspace'
  | 'unknown-skill'
  | 'install-failed'

/**
 * The answer to "is this skill present in that workspace now?".
 *
 * `ok` is "an agent launched in that workspace now would find the skill":
 * true for `installed`, `updated`, `update-available`, `local`, `modified` and
 * `delivered-at-launch`; false for `missing` and every failure. `status` tells
 * "we wrote it" from "a hand-made copy is in the way" from "nobody has ever
 * heard of this skill".
 */
export type EnsureSkillInstalledResult = {
  ok: boolean
  status: ModuleSkillStatus
  message?: string
}

/** What `getSkillStatus` answers: the same shape, read without writing anything. */
export type ModuleSkillStatusResult = EnsureSkillInstalledResult
