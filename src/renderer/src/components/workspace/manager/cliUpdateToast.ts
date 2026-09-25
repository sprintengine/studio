// The toast that offers to update an agent CLI, and running the update
// it offers.

import type { CliVersionAdvisory } from '../../../../../shared/electron-api'
import { executionHostLabel, LOCAL_HOST_ID } from '../../../../../shared/execution-host'
import { useNotificationStore } from '../../../store/notificationStore'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { cliUpdateKey } from '../../../utils/settingsUpdateBadges'
import { cliUpdateNotice } from '../../../utils/feedNotifications'
import { publishDiagnosticSync } from '../../../utils/diagnostics'
import { useToastStore, showToast } from '../../../store/toastStore'
import { cliRuntimeOnMachine } from '../newWorkspace/cliRuntimeOptions'

// The CLI-update toast (owner ruling 2026-09-04): the CLI's glyph,
// "Update available: Codex 0.153.3", and two buttons — Settings, and Update,
// which runs the same command the Settings row runs and reports in place.
// One of the two toasts with actions (the other is the app-update toast);
// main sends each (machine, cli, version) once. A WSL distribution's update
// names the machine, and is its own toast beside this machine's for the same
// CLI: they are two installs, updated separately.
// It leaves after a minute (owner ruling 2026-09-18): a notice nobody asked
// for should not sit in the corner until clicked, and the bell entry below
// and the Settings row still say the same thing once it has gone.
//
// Leaving on its own is not a dismissal: the update's badges (the Settings
// gear, Agents, the machine's segment and the row — owner ruling 2026-09-25)
// stay until the update is installed or the person presses the toast's
// Dismiss, which is them saying "not now" to this version on this machine.
export const CLI_UPDATE_TOAST_MS = 60_000

function toastId(advisory: Pick<CliVersionAdvisory, 'cli' | 'hostId'>): string {
  return advisory.hostId === LOCAL_HOST_ID
    ? `cli-update:${advisory.cli}`
    : `cli-update:${advisory.hostId}:${advisory.cli}`
}

function machineLabel(hostId: CliVersionAdvisory['hostId']): string | null {
  if (hostId === LOCAL_HOST_ID) return null
  return executionHostLabel(hostId, typeof window === 'undefined' ? '' : (window.api?.platform ?? ''))
}

export function showCliUpdateToast(advisory: CliVersionAdvisory): void {
  const store = useWorkspaceStore.getState()
  const displayName = (cli: string): string =>
    store.pluginCatalogEntries.find((entry) => entry.id === cli)?.displayName ?? cli
  const name = displayName(advisory.cli)
  const machine = machineLabel(advisory.hostId)
  const notice = cliUpdateNotice(advisory, displayName, machine)
  const id = toastId(advisory)
  publishDiagnosticSync({
    level: 'info',
    source: 'cli',
    title: notice.title,
    message: advisory.currentVersion ? `Installed ${advisory.currentVersion}` : 'Installed version unknown',
    // The bell's Open lands on the machine the update is for (`agents@<host>`).
    navigationTarget: {
      kind: 'settings',
      ref: advisory.hostId === LOCAL_HOST_ID ? 'agents' : `agents@${advisory.hostId}`,
    },
  })
  const dismiss = (): void => useToastStore.getState().dismissToast(id)
  const dismissUpdate = (): void => useNotificationStore.getState().dismissUpdate(cliUpdateKey(advisory))
  showToast({
    id,
    tone: 'neutral',
    cli: advisory.cli,
    title: notice.title,
    autoDismissMs: CLI_UPDATE_TOAST_MS,
    onDismissPressed: dismissUpdate,
    actions: [
      {
        id: 'settings',
        label: 'Settings',
        run: () => {
          dismiss()
          // The Agents tab opens on the machine the update is for, even when
          // it last showed another one.
          useWorkspaceStore.getState().openSettingsOverlay({ initialTab: 'agents', agentsMachine: advisory.hostId })
        },
      },
      {
        id: 'update',
        label: 'Update',
        primary: true,
        run: () => {
          void runCliUpdateFromToast(advisory, machine ? `${name} (${machine})` : name, id)
        },
      },
    ],
  })
}

export async function runCliUpdateFromToast(
  advisory: Pick<CliVersionAdvisory, 'cli' | 'hostId' | 'currentVersion'>,
  name: string,
  id: string,
): Promise<void> {
  const api = window.api
  if (typeof api.cliUpdate !== 'function') return
  const { cli, hostId } = advisory
  const store = useWorkspaceStore.getState()
  const runtime = cliRuntimeOnMachine(cli, hostId, store.appSettings)
  const before = (hostId === LOCAL_HOST_ID ? store.cliAvailability[cli]?.version : advisory.currentVersion) ?? null
  showToast({ id, tone: 'neutral', cli, title: `Updating ${name}…`, autoDismissMs: false })
  try {
    const result = await api.cliUpdate(cli, runtime)
    if (result.ok && result.version && result.version.trim() !== (before ?? '').trim()) {
      showToast({ id, tone: 'good', cli, title: `${name} updated to ${result.version.trim()}` })
    } else if (result.ok) {
      showToast({
        id,
        tone: 'warn',
        cli,
        title: `${name} did not update`,
        description: `The update finished but the version is still ${before ?? 'the same'}. Settings › Agents has the command to run by hand.`,
      })
    } else {
      showToast({
        id,
        tone: 'warn',
        cli,
        title: `${name} did not update`,
        description: result.error ?? 'The update did not finish.',
      })
    }
  } catch (error) {
    showToast({
      id,
      tone: 'warn',
      cli,
      title: `${name} did not update`,
      description: error instanceof Error ? error.message : String(error),
    })
  }
  // Main detected the CLI again when the update finished and recorded it, for
  // this CLI on this machine only, so these reads pick up the new version
  // without probing anything else.
  const after = useWorkspaceStore.getState()
  if (hostId === LOCAL_HOST_ID) await after.refreshCliAvailability({ cliRuntimes: after.appSettings.cliRuntimes })
  void after.refreshCliVersionAdvisories()
}
