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
 * The answer to "is this skill present in that workspace now?".
 *
 * `status` carries the installer's own vocabulary — `installed`, `updated`,
 * `local`, `modified`, `missing-source`, `missing-workspace`, `unknown-skill`,
 * `install-failed` — so a caller can tell "we wrote it" from "a hand-made copy
 * is in the way" from "nobody has ever heard of this skill".
 */
export type EnsureSkillInstalledResult = {
  ok: boolean
  status: string
  message?: string
}
