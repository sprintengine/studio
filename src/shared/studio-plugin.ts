// The app's own plugin as the catalogue shows it.
//
// Renderer-safe (no node imports): the built-in row is the first row of the
// SprintEngine Studio tab in every catalogue that has one, and deriving it here
// keeps the chips, the words and the drift rule testable without a DOM.
//
// The row has no Install and no Remove. This plugin is not something a person
// chose and can therefore un-choose: the app writes it into every workspace it
// opens and writes it back when someone deletes it, so an Install button would
// do nothing and a Remove button would lie
// (backlog/2026-09-06-sprintengine-studio-ships-as-a-plugin.md).

import type { StudioPluginStatus } from './electron-api'

/**
 * The plugin's id — its directory in the marketplace, and its `name` in both
 * manifests. Lives here rather than only in main because the catalogues have to
 * recognise it: our marketplace lists it like any other plugin, and the row it
 * gets there is the built-in row below, not an installable one.
 */
export const STUDIO_PLUGIN_ID = 'sprintengine-studio'

const STUDIO_PLUGIN_ROW_NAME = 'SprintEngine Studio'

const STUDIO_PLUGIN_ROW_DESCRIPTION =
  'Sprints, backlog, automations, workspaces and terminals, review — the bridge to this app and the skills that teach it.'

export type StudioPluginRow = {
  name: string
  description: string
  /** Version-and-state line under the name. */
  summary: string
  chips: string[]
  /** The app ships a newer plugin than this workspace holds. */
  updateAvailable: boolean
}

/**
 * The built-in row, or null when this build shipped no plugin to describe —
 * an absent row is honest, and a row saying "version " is not.
 *
 * Drift is `bundledVersion` against `installedVersion`, which is what the
 * workspace actually holds. It closes itself: the next time the workspace is
 * opened the app reinstalls, so the row states the difference rather than
 * offering a button that would race the thing already about to happen.
 */
export function deriveStudioPluginRow(status: Partial<StudioPluginStatus> | null): StudioPluginRow | null {
  // Every field is read defensively. This crosses IPC, so at runtime it is
  // whatever the other side sent — an older preload, a stub, or a handler that
  // is not registered at all — and a row is not worth throwing a render for.
  const bundledVersion = typeof status?.bundledVersion === 'string' ? status.bundledVersion : ''
  if (bundledVersion === '') return null
  const installedVersion = typeof status?.installedVersion === 'string' ? status.installedVersion : ''
  const skillCount = Array.isArray(status?.skillDirNames) ? status.skillDirNames.length : 0
  const installed = installedVersion !== ''
  const updateAvailable = installed && installedVersion !== bundledVersion
  const summary = !installed
    ? `Version ${bundledVersion}. Open a workspace and it is installed into it.`
    : updateAvailable
      ? `This workspace has ${installedVersion}; the app ships ${bundledVersion}. Reopening it applies the newer one.`
      : `Version ${bundledVersion}. ${countedSkills(skillCount)} in this workspace.`
  return {
    name: STUDIO_PLUGIN_ROW_NAME,
    description: STUDIO_PLUGIN_ROW_DESCRIPTION,
    summary,
    chips: [
      'Plugin',
      ...(installed ? ['Installed'] : []),
      'Built in',
      ...(updateAvailable ? ['Update available'] : []),
    ],
    updateAvailable,
  }
}

function countedSkills(count: number): string {
  return `${count} ${count === 1 ? 'skill' : 'skills'}`
}

/** Whether a search over this tab should still show the built-in row. */
export function studioPluginRowMatches(row: StudioPluginRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return `${row.name} ${row.description} built in plugin`.toLowerCase().includes(needle)
}
