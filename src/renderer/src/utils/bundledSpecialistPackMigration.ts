/**
 * One-time update-migration for MC-1587 (un-ship the bundled specialist pack).
 *
 * Before this change the 17 specialist roles shipped inside the app and every
 * picker showed them by default. They now install like any other pack, so a
 * fresh profile starts raw-first (general only). To preserve continuity for
 * people who already had the pack on, on the first launch after updating we
 * install the shipped pack into the user-global registry for exactly those
 * users — the MC-78 toggle state is the signal:
 *
 * - enabled (pack id absent from `specialistPacks.disabled`) → install once
 * - disabled → install nothing, just record the migration ran
 * - fresh profile → never reaches here: it hydrates with
 *   `migratedBundledPack: true` (see `defaultAppSettings`), so nothing installs
 *
 * The renderer owns the run-once guard and the enabled decision; main copies the
 * pack (`sprintengine:specialist-pack:install-bundled`) and invalidates its role
 * catalog. After a successful install we re-read the role registry so the
 * spawn/composer/palette pickers populate in the same session, no restart.
 */
import { buildSprintEngineRoleRegistry } from '../../../shared/sprintengine/state'
import { useWorkspaceStore } from '../store/workspaceStore'

// The pack id the MC-78 toggle persisted into `specialistPacks.disabled`. Kept
// as a literal here (not imported) so the migration does not depend on the
// bundled-catalog constants being retired alongside this change.
const BUNDLED_SPECIALIST_PACK_ID = 'multicode-specialists'

// Re-read the user-global registry against any folder-backed workspace (the
// user layer is workspace-independent) and push it into the store so the
// registry-sourced pickers reflect the freshly installed pack immediately.
async function refreshRoleRegistryAfterInstall(): Promise<void> {
  const read = window.api?.readSprintEngineRegistryRoles
  if (typeof read !== 'function') return
  const { workspaces, activeWorkspaceId, setSprintEngineRoleRegistry } = useWorkspaceStore.getState()
  const activeFolder = workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.folderPath
  const workspaceRoot =
    (activeFolder && activeFolder.trim() ? activeFolder : null) ??
    workspaces.find((workspace) => Boolean(workspace.folderPath?.trim()))?.folderPath
  if (!workspaceRoot) return
  const result = await read({ workspaceRoot, includeShadowed: false })
  if (result.ok) setSprintEngineRoleRegistry(buildSprintEngineRoleRegistry(result.data))
}

export async function runBundledSpecialistPackMigration(): Promise<void> {
  const install = window.api?.installBundledSpecialistPack
  // Not an Electron renderer (or preload not ready): leave the guard untouched
  // so a real launch still gets its one chance to migrate.
  if (typeof install !== 'function') return

  const state = useWorkspaceStore.getState()
  const packs = state.appSettings.specialistPacks
  if (packs?.migratedBundledPack) return

  const enabled = !(packs?.disabled ?? []).includes(BUNDLED_SPECIALIST_PACK_ID)
  if (!enabled) {
    // The user had the bundled pack off before the update — honor that by
    // installing nothing, and record the migration so it never re-evaluates.
    state.markBundledSpecialistPackMigrated()
    return
  }

  try {
    const result = await install()
    if (!result.ok) {
      // Surface the failure and leave the guard unset so a fixed build retries;
      // never claim a migration that did not land.
      console.error('[BundledPackMigration] install reported failure', result)
      return
    }
    useWorkspaceStore.getState().markBundledSpecialistPackMigrated()
    await refreshRoleRegistryAfterInstall()
  } catch (error) {
    console.error('[BundledPackMigration] install threw', error)
  }
}
